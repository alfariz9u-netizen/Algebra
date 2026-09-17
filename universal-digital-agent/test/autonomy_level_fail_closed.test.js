"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

/**
 * Regression test for the NaN fail-open bug: `Number(process.env
 * .AUTONOMY_LEVEL ?? 0)` on a malformed value (e.g. a typo) produced NaN,
 * and `NaN < 2` is `false` — so `riskEngine.requiresHumanApproval` silently
 * treated a MEDIUM-risk action as NOT needing approval. Both the source of
 * the value (autonomyLevels.currentLevel) and the consumer (riskEngine
 * .requiresHumanApproval) must fail CLOSED to the most restrictive level.
 */
test("autonomy level parsing and risk gating fail closed on bad input", async (t) => {
  const ORIGINAL_ENV = process.env.AUTONOMY_LEVEL;

  await t.test("currentLevel() falls back to 0 for a non-numeric env value", () => {
    process.env.AUTONOMY_LEVEL = "not-a-number";
    delete require.cache[require.resolve("../src/core/autonomyLevels")];
    const { currentLevel } = require("../src/core/autonomyLevels");
    assert.strictEqual(currentLevel(), 0);
  });

  await t.test("currentLevel() falls back to 0 for an out-of-range level", () => {
    process.env.AUTONOMY_LEVEL = "99";
    delete require.cache[require.resolve("../src/core/autonomyLevels")];
    const { currentLevel } = require("../src/core/autonomyLevels");
    assert.strictEqual(currentLevel(), 0);
  });

  await t.test("currentLevel() falls back to 0 for a non-integer level", () => {
    process.env.AUTONOMY_LEVEL = "1.5";
    delete require.cache[require.resolve("../src/core/autonomyLevels")];
    const { currentLevel } = require("../src/core/autonomyLevels");
    assert.strictEqual(currentLevel(), 0);
  });

  await t.test("currentLevel() still correctly parses a valid level", () => {
    process.env.AUTONOMY_LEVEL = "2";
    delete require.cache[require.resolve("../src/core/autonomyLevels")];
    const { currentLevel } = require("../src/core/autonomyLevels");
    assert.strictEqual(currentLevel(), 2);
  });

  await t.test("currentLevel() defaults to 0 when unset", () => {
    delete process.env.AUTONOMY_LEVEL;
    delete require.cache[require.resolve("../src/core/autonomyLevels")];
    const { currentLevel } = require("../src/core/autonomyLevels");
    assert.strictEqual(currentLevel(), 0);
  });

  await t.test("riskEngine.requiresHumanApproval never fails open on a non-finite autonomy level", () => {
    const riskEngine = require("../src/core/riskEngine");
    // This is exactly the value the old bug could produce.
    assert.strictEqual(riskEngine.requiresHumanApproval("SEND_MESSAGE", NaN), true);
    assert.strictEqual(riskEngine.requiresHumanApproval("SEND_MESSAGE", undefined), true);
    // A genuinely sufficient autonomy level still correctly skips approval.
    assert.strictEqual(riskEngine.requiresHumanApproval("SEND_MESSAGE", 2), false);
    // HIGH risk is gated regardless, valid or not.
    assert.strictEqual(riskEngine.requiresHumanApproval("MAKE_PAYMENT", NaN), true);
    assert.strictEqual(riskEngine.requiresHumanApproval("MAKE_PAYMENT", 3), true);
  });

  if (ORIGINAL_ENV === undefined) delete process.env.AUTONOMY_LEVEL;
  else process.env.AUTONOMY_LEVEL = ORIGINAL_ENV;
});
