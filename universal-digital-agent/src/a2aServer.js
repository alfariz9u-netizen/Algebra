"use strict";

/**
 * Inbound Agent2Agent (A2A) server — the other half of `a2aClient.js`.
 * That file lets THIS agent call OUT to another agent; this file makes
 * THIS agent discoverable and callable BY other agents, per the official
 * spec (https://a2a-protocol.org/dev/specification/):
 *
 *   GET  /.well-known/agent-card.json   — public discovery document
 *   POST /a2a                           — JSON-RPC 2.0, `message/send` only
 *
 * HONESTY NOTE (scope): this implements the synchronous `message/send`
 * happy path only — no `tasks/get` polling, no streaming (SSE), no push
 * notifications. A request that needs human approval gets a Task back in
 * the `input-required` state with the approvalId mentioned in the message
 * text, but there is no endpoint yet for the caller to poll that task to
 * completion — the operator has to approve it out of band (CLI/Telegram)
 * and the caller would need to retry later or be told out-of-band. Good
 * enough to be genuinely callable; not a complete implementation of the
 * spec's async task lifecycle.
 *
 * HONESTY NOTE (payment): the A2A message/send spec carries no payment
 * mechanism. `rewardUsd` recorded in economics for an inbound request is
 * whatever the caller *claims* in `message.metadata.rewardUsd` — entirely
 * self-reported and unverified. Do not treat this as guaranteed income;
 * it exists so a caller who *does* pay out-of-band (escrow, invoice, a
 * platform wrapping A2A) can have that reflected in the dashboard.
 *
 * SECURITY — every inbound message goes through the exact same gates as
 * every other task source in this project, with nothing bypassed:
 *   - `agent.processTask()` runs the full pipeline: intent classification,
 *     the risk/autonomy gate (a request that maps to a MEDIUM/HIGH-risk
 *     capability lands in the human approval queue, it does NOT
 *     auto-execute just because a remote agent phrased it a certain way),
 *     token/budget preflight, verification, and QA — identical treatment
 *     to a marketplace bid or a CLI-submitted task.
 *   - The caller's message text is ALWAYS routed through
 *     `task.untrustedContent` (never trusted, never treated as
 *     instructions to the framework itself) — see promptInjectionGuard.js.
 *   - A response body size cap and a dedicated per-IP rate limiter (kept
 *     separate from the outbound connector-call rate limiter, so a noisy
 *     public endpoint can't starve the agent's own marketplace bidding)
 *     protect against a hostile or misbehaving caller running up LLM
 *     costs or exhausting memory.
 *   - An optional shared-secret bearer token
 *     (`A2A_SERVER_SHARED_SECRET`) can restrict who may call `/a2a` at
 *     all; discovery (`agent-card.json`) is always public, per spec norms
 *     — an agent that can't be found can't be hired.
 *
 * Usage:
 *   export A2A_SERVER_PORT=8787
 *   export A2A_SERVER_PUBLIC_URL=https://your-service.onrender.com
 *   export A2A_SERVER_SHARED_SECRET="a long random token"   # optional but recommended
 *   node src/a2aServer.js
 */

const http = require("node:http");
const crypto = require("node:crypto");
const RateLimiter = require("./core/rateLimiter");
const { buildAgent } = require("./index");
const { CAPABILITIES } = require("./capabilities/definitions");

const MAX_BODY_BYTES = Number(process.env.A2A_SERVER_MAX_BODY_BYTES || 256 * 1024); // 256KB
const PORT = Number(process.env.A2A_SERVER_PORT || 8787);
const PUBLIC_URL = (process.env.A2A_SERVER_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SHARED_SECRET = process.env.A2A_SERVER_SHARED_SECRET || null;
const AGENT_NAME = process.env.A2A_SERVER_AGENT_NAME || "Universal Digital Agent";
const AGENT_DESCRIPTION =
  process.env.A2A_SERVER_AGENT_DESCRIPTION ||
  "An autonomous agent offering research, analysis, writing, and automation. Every request is checked against risk/budget/human-approval gates before it executes.";

function buildAgentCard() {
  const skills = Object.values(CAPABILITIES).map((cap) => ({
    id: cap.name,
    name: cap.name,
    description: cap.description,
    tags: [String(cap.riskLevel || "LOW").toLowerCase()],
  }));
  return {
    protocolVersion: "0.2.9",
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    url: `${PUBLIC_URL}/a2a`,
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
    ...(SHARED_SECRET
      ? { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Contact the operator for a token." } }, security: [{ bearerAuth: [] }] }
      : {}),
  };
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  if (!SHARED_SECRET) return true;
  const match = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] || "");
  return Boolean(match && safeEqual(match[1], SHARED_SECRET));
}

function textFromMessage(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p) => p && p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Handles one already-authenticated, already-rate-limited JSON-RPC body. Exported for direct unit testing. */
async function handleA2aRequest(agent, rawBody, { remoteAddress = "unknown" } = {}) {
  let rpc;
  try {
    rpc = JSON.parse(rawBody);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON." } };
  }

  const { id = null, method, params } = rpc || {};
  if (method !== "message/send") {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: "${method}". Only "message/send" is implemented.` } };
  }

  const text = textFromMessage(params?.message);
  if (!text) {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: message.parts must contain at least one non-empty text part." } };
  }

  const taskId = `a2a-in-${crypto.randomUUID()}`;
  const callerUrl = params?.message?.metadata?.callerAgentUrl || null;
  agent.audit.record({
    agentId: agent.agentId,
    taskId,
    action: "A2A_INBOUND_REQUEST",
    result: `from ${remoteAddress}${callerUrl ? ` (${callerUrl})` : ""}`,
    riskLevel: "LOW",
  });

  const task = {
    id: taskId,
    type: "a2a_inbound_request", // not a known capability name — forces real classification of the caller's text below
    input: { topic: text, query: text, description: text },
    untrustedContent: text,
    untrustedSource: `a2a:${callerUrl || "unknown-remote-agent"}`,
    sourceConnector: "a2a-inbound",
    // Self-reported by the caller, unverified — see HONESTY NOTE (payment) above.
    rewardUsd: Number(params?.message?.metadata?.rewardUsd) || 0,
  };

  let result;
  try {
    result = await agent.processTask(task);
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: { kind: "task", id: taskId, status: { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: `Internal error: ${err.message}` }] } } },
    };
  }

  if (result.status === "success") {
    return {
      jsonrpc: "2.0",
      id,
      result: { kind: "message", role: "agent", messageId: crypto.randomUUID(), taskId, parts: [{ kind: "text", text: result.output }] },
    };
  }
  if (result.status === "pending_human_approval") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "task",
        id: taskId,
        status: {
          state: "input-required",
          message: {
            role: "agent",
            parts: [
              {
                kind: "text",
                text: `This request requires human approval before it can execute (approvalId: ${result.approvalId}). There is no status-polling endpoint yet — please retry later or contact the operator.`,
              },
            ],
          },
        },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    result: { kind: "task", id: taskId, status: { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: result.reason || "Task did not complete successfully." }] } } },
  };
}

function createServer(agent, { rateLimiter } = {}) {
  const inboundLimiter =
    rateLimiter ||
    new RateLimiter({
      capacity: Number(process.env.A2A_SERVER_RATE_LIMIT_CAPACITY || 5),
      refillPerSecond: Number(process.env.A2A_SERVER_RATE_LIMIT_REFILL_PER_SEC || 0.2), // 1 request per 5s sustained, bursts of 5
    });

  return http.createServer((req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      return send(200, buildAgentCard());
    }
    if (req.method === "GET" && req.url === "/healthz") {
      return send(200, { status: "ok" });
    }
    if (req.method !== "POST" || req.url !== "/a2a") {
      return send(404, { error: "Not found. POST to /a2a with a message/send JSON-RPC body." });
    }

    if (!isAuthorized(req)) {
      return send(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized." } });
    }

    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return send(413, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Request body too large (max ${MAX_BODY_BYTES} bytes).` } });
    }

    const remoteAddress = req.socket.remoteAddress || "unknown";
    if (!inboundLimiter.tryConsume(remoteAddress)) {
      return send(429, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Rate limit exceeded. Slow down." } });
    }

    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy(); // no response sent on this path — a client lying about content-length gets a reset connection, not a crafted error
      }
    });
    req.on("end", async () => {
      if (tooLarge) return;
      try {
        send(200, await handleA2aRequest(agent, body, { remoteAddress }));
      } catch (err) {
        send(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: `Internal error: ${err.message}` } });
      }
    });
    req.on("error", () => {});
  });
}

function start() {
  const agent = buildAgent();
  const server = createServer(agent);
  server.listen(PORT, () => {
    console.log(`A2A server listening on port ${PORT}`);
    console.log(`Agent card: ${PUBLIC_URL}/.well-known/agent-card.json`);
    if (!SHARED_SECRET) {
      console.warn(
        "WARNING: A2A_SERVER_SHARED_SECRET is not set — /a2a accepts requests from anyone on the internet who finds it. " +
          "Every request still passes through the full risk/approval/budget gate, but set a shared secret to cut down on noise/abuse."
      );
    }
  });
  return { server, agent };
}

module.exports = { createServer, buildAgentCard, handleA2aRequest, start };

if (require.main === module) start();
