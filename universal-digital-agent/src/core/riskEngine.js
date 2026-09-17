"use strict";

/**
 * Deterministic risk classification (spec section 19). No LLM call —
 * risk tier is looked up from the action, not "decided" by a model.
 */

const RISK_TIERS = {
  LOW: [
    "READ_PUBLIC_WEB",
    "READ_FILES",
    "READ_EMAIL",
    "READ_GITHUB",
  ],
  MEDIUM: [
    "SEND_EMAIL",
    "SEND_MESSAGE",
    "PUBLISH",
    "WRITE_GITHUB",
    "CREATE_PULL_REQUEST",
    "USE_EXTERNAL_API",
    "USE_MCP_TOOL",
    "USE_A2A",
    "SUBMIT_TASK",
  ],
  HIGH: [
    "MAKE_PAYMENT",
    "WITHDRAW_FUNDS",
    "RECEIVE_PAYMENT",
    "MODIFY_AGENT",
    "MODIFY_SYSTEM",
  ],
};

function classify(action) {
  for (const [level, actions] of Object.entries(RISK_TIERS)) {
    if (actions.includes(action)) return level;
  }
  return "HIGH"; // unknown action defaults to the safest (most restrictive) tier
}

function requiresHumanApproval(action, autonomyLevel) {
  const level = classify(action);
  if (level === "HIGH") return true; // always gated regardless of autonomy level, per spec
  // Defense in depth: any non-finite/invalid autonomyLevel (NaN, undefined,
  // a string, etc.) must fail CLOSED — i.e. be treated as the most
  // restrictive level (0) — never silently pass a comparison like
  // `NaN < 2` (which is false and would fail OPEN).
  const safeLevel = Number.isFinite(autonomyLevel) ? autonomyLevel : 0;
  if (level === "MEDIUM" && safeLevel < 2) return true;
  return false;
}

module.exports = { classify, requiresHumanApproval, RISK_TIERS };
