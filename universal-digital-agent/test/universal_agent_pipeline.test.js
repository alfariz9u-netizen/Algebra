"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createFixtureServer } = require("./fixture_server");

async function main() {
  const port = 8936;
  const server = await createFixtureServer(port);

  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.AUTONOMY_LEVEL = "2"; // limited autonomy: low-risk actions run without approval

  // Fresh require so env vars above are picked up by module-level defaults.
  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");

  try {
    const agent = new UniversalAgent();

    const task = {
      id: "e2e-task-1",
      type: "research_report",
      input: { topic: "renewable energy adoption" },
    };

    const result = await agent.processTask(task);
    console.log("Result:", JSON.stringify(result, null, 2));

    assert.strictEqual(result.status, "success", "Task should complete via real classify -> LLM -> verify -> QA -> deliver");
    assert.strictEqual(result.capability, "research", "Deterministic keyword classifier should route 'research_report' correctly");
    assert.ok(result.output.includes("fixture research output"));
    assert.ok(result.meta.qaScore >= 80);
    console.log("PASS: full UniversalAgent pipeline runs end to end on real code paths");

    // Second identical task should hit cache (exact match) and skip the LLM entirely.
    const result2 = await agent.processTask({ ...task, id: "e2e-task-2" });
    assert.strictEqual(result2.meta.cached, true, "Second identical task should be served from cache, not a new LLM call");
    console.log("PASS: repeat task is served from the exact-match cache");

    const dash = agent.dashboard();
    assert.ok(dash.economics.countsByType.task_completed >= 1);
    console.log("PASS: dashboard reflects real economics/audit state");
  } finally {
    server.close();
  }
}

test("UniversalAgent pipeline test", async () => {
  await main();
});
