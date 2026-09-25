"use strict";
/**
 * Render-compatible entry point.
 * Render's free Web Service requires the app to listen on process.env.PORT
 * so its health check passes. This project has no HTTP server by default
 * (it's a long-polling Telegram bot), so this tiny wrapper adds one and
 * starts the real bot alongside it.
 *
 * It also exposes a PAID service endpoint, POST /paid/research, using the
 * x402 protocol via OKX's Facilitator (see connectors/okxFacilitator.js).
 * Unlike everything else in this project (which bids on OTHER agents'
 * jobs), this is the agent SELLING its own research/synthesis capability
 * to any caller on the internet, settled automatically in USDC on X Layer.
 *
 * Flow: caller POSTs {question}. No payment yet -> we reply 402 with a
 * price quote. Caller pays and retries with an X-PAYMENT header -> we
 * verify it with OKX, do the actual work, settle the payment, and return
 * the answer. Kept deliberately at a tiny default price while unproven.
 */
const http = require("http");
const { buildAgent } = require("./src/index");
const OKXFacilitator = require("./src/connectors/okxFacilitator");

const PORT = process.env.PORT || 3000;
const RESEARCH_PRICE_USD = Number(process.env.OKX_RESEARCH_PRICE_USD || 0.05);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handlePaidResearch(req, res, resourceUrl) {
  const facilitator = new OKXFacilitator();
  if (facilitator.status() !== "CONNECTED") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Paid research endpoint not configured (missing OKX credentials)." }));
    return;
  }

  const requirements = facilitator.buildRequirements({
    priceUsd: RESEARCH_PRICE_USD,
    resourceUrl,
    description: "AI research & synthesis on a topic you provide.",
  });

  const paymentHeader = req.headers["x-payment"];

  if (!paymentHeader) {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, accepts: [requirements] }));
    return;
  }

  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Malformed X-PAYMENT header: ${err.message}` }));
    return;
  }

  try {
    const verifyResult = await facilitator.verify(paymentPayload, requirements);
    if (verifyResult && verifyResult.isValid === false) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: 1, accepts: [requirements], error: verifyResult.invalidReason || "payment verification failed" }));
      return;
    }

    const bodyText = await readBody(req);
    let question = "";
    try {
      question = JSON.parse(bodyText || "{}").question || "";
    } catch {
      // ignore — empty question handled below
    }
    if (!question) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Request body must be JSON: {"question": "..."}' }));
      return;
    }

    const agent = buildAgent();
    const outcome = await agent.processTask({
      id: `paid-research-${Date.now()}`,
      type: "research",
      input: { topic: question },
      // FIX: the caller's own text is external, unauthenticated input —
      // never trusted as instructions to the framework itself, same as
      // every marketplace listing's description elsewhere in this project.
      untrustedContent: question,
      untrustedSource: "x402-paid-caller",
    });

    // FIX: only settle -- i.e. only actually move the caller's money --
    // when a real deliverable was produced. A failed or pending-approval
    // outcome must never capture payment for nothing delivered.
    if (outcome.status !== "success") {
      const statusCode = outcome.status === "pending_human_approval" ? 202 : 502;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            outcome.status === "pending_human_approval"
              ? "This request requires human review before it can be completed. You have NOT been charged. Please try again later."
              : `The request could not be completed (${outcome.reason || "unknown reason"}). You have NOT been charged.`,
        })
      );
      return;
    }

    const settleResult = await facilitator.settle(paymentPayload, requirements);

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settleResult)).toString("base64"),
    });
    res.end(JSON.stringify({ answer: outcome.output }));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/paid/research" && req.method === "POST") {
      const resourceUrl = `https://${req.headers.host}/paid/research`;
      handlePaidResearch(req, res, resourceUrl).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("universal-digital-agent: alive\n");
  })
  .listen(PORT, () => {
    console.log(`Health-check server listening on port ${PORT}`);
  });

const TelegramApprovalBot = require("./src/telegramApprovalBot");

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.log("TELEGRAM_BOT_TOKEN not set - health server running, bot not started.");
} else {
  const bot = new TelegramApprovalBot();
  console.log(`Telegram approval bot starting (allowlist: ${[...bot.allowedChatIds].join(", ")})...`);
  bot.start().catch((err) => {
    console.error("Bot crashed:", err);
  });
}
