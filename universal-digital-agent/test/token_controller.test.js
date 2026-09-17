"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { TokenController } = require("../src/core/tokenController");

function main() {
  const controller = new TokenController({
    maxTokensPerTask: 5000,
    maxLlmCallsPerTask: 2,
    maxTokensPerOperation: 2000,
    maxDailyTokens: 100000,
    maxOutputTokens: 500,
  });

  const ok = controller.preflight("t1", { systemPrompt: "short", userPrompt: "short" });
  assert.strictEqual(ok.allowed, true);
  console.log("PASS: small prompt allowed under budget");

  const tooBig = controller.preflight("t1", { systemPrompt: "x".repeat(5000), userPrompt: "y".repeat(5000) });
  assert.strictEqual(tooBig.allowed, false);
  assert.ok(tooBig.reasons.length > 0);
  console.log("PASS: oversized single operation rejected with a reason");

  controller.record("t1", 50);
  controller.record("t1", 50);
  const overCalls = controller.preflight("t1", { systemPrompt: "s", userPrompt: "u" });
  assert.strictEqual(overCalls.allowed, false);
  console.log("PASS: exceeding maxLlmCallsPerTask is rejected");
}

test("Token controller tests", async () => {
  main();
});
