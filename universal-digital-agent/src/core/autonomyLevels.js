"use strict";

/**
 * Autonomy levels (spec section 23). Deterministic gate — the level number
 * controls what the agent may do WITHOUT stopping for human approval.
 * High-risk actions remain gated regardless of level (see riskEngine.js).
 */
const AUTONOMY_LEVELS = {
  0: { name: "MANUAL", description: "Every external action requires approval." },
  1: { name: "ASSISTED", description: "Agent can research and prepare actions, not execute them." },
  2: { name: "LIMITED_AUTONOMY", description: "Agent can perform approved low-risk actions automatically." },
  3: { name: "CONTROLLED_AUTONOMY", description: "Agent can execute predefined workflows within strict budgets and permissions." },
};

function getLevel(levelNumber) {
  return AUTONOMY_LEVELS[levelNumber] || AUTONOMY_LEVELS[0];
}

function currentLevel() {
  const raw = process.env.AUTONOMY_LEVEL;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  // A malformed value (e.g. a typo) must fail CLOSED to the most restrictive
  // level, not fail OPEN. Number("garbage") is NaN, and NaN < 2 is false,
  // which previously caused MEDIUM-risk actions to silently skip human
  // approval — a fail-open bug. Guard against NaN and any non-integer/
  // out-of-range value explicitly.
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || !AUTONOMY_LEVELS[parsed]) {
    return 0;
  }
  return parsed;
}

module.exports = { AUTONOMY_LEVELS, getLevel, currentLevel };
