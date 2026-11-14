"use strict";
/**
 * Render-compatible entry point (alternative to src/combinedServer.js; `npm run start:combined` is the
 * recommended one). Adds a health check and a PAID endpoint, POST /paid/research, using the x402
 * protocol via OKX's Facilitator (see connectors/okxFacilitator.js): the agent SELLING its research
 * capability, settled in USDC on X Layer.
 *
 * Flow: caller POSTs {question}. No payment -> 402 with a price quote. Caller pays and retries with an
 * X-PAYMENT header -> we verify it, do the work, settle, and return the answer.
 *
 * Money safety (each of these was a real bug):
 *  - ONE shared agent for the whole process (a fresh agent per request reset token budgets/rate limits).
 *  - A payment can be used ONCE: concurrent requests carrying the same X-PAYMENT used to all be served
 *    while settle() charged a single time.
 *  - The answer is only returned when settlement is explicitly successful (a failed settle used to
 *    still return the answer for free).
 *  - Request bodies are size-capped; settled payments are recorded in the economics ledger.
 */
const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY_BYTES = Number(process.env.PAID_MAX_BODY_BYTES) > 0 ? Number(process.env.PAID_MAX_BODY_BYTES) : 64 * 1024;
const MAX_QUESTION_CHARS = Number(process.env.PAID_MAX_QUESTION_CHARS) > 0 ? Number(process.env.PAID_MAX_QUESTION_CHARS) : 4000;
const MAX_REMEMBERED_PAYMENTS = 10000;

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error(`Request body too large (max ${maxBytes} bytes).`), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** True only for an explicit success. Accepts {success:true}, {data:{success:true}}, {data:[{success:true}]}. */
function settlementSucceeded(result) {
  if (!result || typeof result !== "object") return false;
  const nodes = [result, result.data, ...(Array.isArray(result.data) ? result.data : [])].filter((n) => n && typeof n === "object");
  if (nodes.some((n) => n.success === false)) return false;
  return nodes.some((n) => n.success === true);
}

function settlementTx(result) {
  const nodes = [result, result?.data, ...(Array.isArray(result?.data) ? result.data : [])].filter((n) => n && typeof n === "object");
  for (const n of nodes) {
    const tx = n.transaction || n.txHash || n.txSignature || n.tx_hash;
    if (tx) return String(tx);
  }
  return null;
}

function createPaidServer({ getAgent, facilitator, priceUsd }) {
  const usedPayments = new Map(); // sha256(X-PAYMENT) -> "inflight" | "settled" (bounded, oldest evicted)
  const remember = (key, state) => {
    usedPayments.delete(key);
    usedPayments.set(key, state);
    while (usedPayments.size > MAX_REMEMBERED_PAYMENTS) usedPayments.delete(usedPayments.keys().next().value);
  };
  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  };

  async function handlePaidResearch(req, res, resourceUrl) {
    if (facilitator.status() !== "CONNECTED") {
      return json(res, 503, { error: "Paid research endpoint not configured (missing OKX credentials)." });
    }
    const requirements = facilitator.buildRequirements({ priceUsd, resourceUrl, description: "AI research & synthesis on a topic you provide." });

    const paymentHeader = req.headers["x-payment"];
    if (!paymentHeader) return json(res, 402, { x402Version: 1, accepts: [requirements] });

    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(String(paymentHeader), "base64").toString("utf8"));
    } catch (err) {
      return json(res, 400, { error: `Malformed X-PAYMENT header: ${err.message}` });
    }

    const paymentKey = crypto.createHash("sha256").update(String(paymentHeader)).digest("hex");
    if (usedPayments.has(paymentKey)) {
      return json(res, 402, { x402Version: 1, accepts: [requirements], error: "This payment has already been used." });
    }
    remember(paymentKey, "inflight"); // claimed BEFORE any await: concurrent replays are refused
    let finished = false;
    try {
      // Read and validate the body first: no point verifying/settling for an unusable request.
      let question = "";
      try {
        question = String(JSON.parse((await readBody(req)) || "{}").question || "").trim();
      } catch (err) {
        if (err.statusCode === 413) {
          usedPayments.delete(paymentKey);
          return json(res, 413, { error: err.message });
        }
        question = "";
      }
      if (!question) {
        usedPayments.delete(paymentKey);
        return json(res, 400, { error: 'Request body must be JSON: {"question": "..."}' });
      }
      if (question.length > MAX_QUESTION_CHARS) {
        usedPayments.delete(paymentKey);
        return json(res, 413, { error: `Question too long (max ${MAX_QUESTION_CHARS} characters).` });
      }

      const verifyResult = await facilitator.verify(paymentPayload, requirements);
      if (verifyResult && (verifyResult.isValid === false || verifyResult.success === false)) {
        usedPayments.delete(paymentKey);
        return json(res, 402, { x402Version: 1, accepts: [requirements], error: verifyResult.invalidReason || "payment verification failed" });
      }

      const agent = await getAgent();
      const taskId = `paid-research-${crypto.randomUUID()}`;
      const outcome = await agent.processTask({
        id: taskId,
        type: "research",
        input: { topic: question },
        // The caller's text is external, unauthenticated input — never instructions.
        untrustedContent: question,
        untrustedSource: "x402-paid-caller",
        sourceConnector: "x402",
      });

      // Only settle (move money) when a real deliverable exists; otherwise release the payment for a retry.
      if (outcome.status !== "success") {
        usedPayments.delete(paymentKey);
        const pending = outcome.status === "pending_human_approval";
        return json(res, pending ? 202 : 502, {
          error: pending
            ? "This request requires human review before it can be completed. You have NOT been charged. Please try again later."
            : `The request could not be completed (${outcome.reason || "unknown reason"}). You have NOT been charged.`,
        });
      }

      const settleResult = await facilitator.settle(paymentPayload, requirements);
      if (!settlementSucceeded(settleResult)) {
        // Do not hand over the answer for free. Keep the key burned: the payment's state is uncertain.
        finished = true;
        remember(paymentKey, "settled");
        console.error(`[paid/research] settlement not confirmed for ${taskId}: ${JSON.stringify(settleResult).slice(0, 300)}`);
        return json(res, 402, { x402Version: 1, accepts: [requirements], error: "Payment settlement was not confirmed; no answer was delivered." });
      }
      finished = true;
      remember(paymentKey, "settled");

      try {
        agent.economics.recordPayment({
          taskId,
          amountUsd: priceUsd,
          txSignature: settlementTx(settleResult) || `x402:${paymentKey}`,
          network: "xlayer",
          token: "USDC",
          connector: "x402",
        });
      } catch (err) {
        console.warn(`[paid/research] could not record payment: ${err.message}`);
      }

      return json(res, 200, { answer: outcome.output }, { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settleResult)).toString("base64") });
    } catch (err) {
      if (!finished) usedPayments.delete(paymentKey); // failed before settlement: the caller may retry
      return json(res, 502, { error: err.message });
    }
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/paid/research" && req.method === "POST") {
      const resourceUrl = `https://${req.headers.host}/paid/research`;
      handlePaidResearch(req, res, resourceUrl).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: err.message });
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("universal-digital-agent: alive\n");
  });
}

async function main() {
  const { buildAgent } = require("./src/index");
  const OKXFacilitator = require("./src/connectors/okxFacilitator");
  const TelegramApprovalBot = require("./src/telegramApprovalBot");
  const PORT = process.env.PORT || 3000;
  const priceUsd = Number(process.env.OKX_RESEARCH_PRICE_USD) > 0 ? Number(process.env.OKX_RESEARCH_PRICE_USD) : 0.05;

  const agent = buildAgent();
  await agent.ready;
  const server = createPaidServer({ getAgent: async () => agent, facilitator: new OKXFacilitator(), priceUsd });
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Health-check server listening on port ${PORT}`);

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("TELEGRAM_BOT_TOKEN not set - health server running, bot not started.");
  } else {
    const bot = new TelegramApprovalBot();
    console.log(`Telegram approval bot starting (allowlist: ${[...bot.allowedChatIds].join(", ")})...`);
    bot.start().catch((err) => console.error("Bot crashed:", err));
  }
  const shutdown = () => {
    Promise.race([agent.flushState(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { createPaidServer, settlementSucceeded, settlementTx, readBody };

if (require.main === module) {
  main().catch((err) => {
    console.error("[server] fatal startup error:", err);
    process.exit(1);
  });
}
