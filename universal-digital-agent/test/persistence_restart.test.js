"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixtureServer } = require("./fixture_server");

async function main() {
  const port = 8943;
  const server = await createFixtureServer(port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-restart-test-"));

  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";

  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");

  try {
    // --- "Process 1": run a task, with persistence enabled ---
    const agent1 = new UniversalAgent({ persistDir: dataDir });
    const task = {
      id: "restart-test-task",
      type: "research_report",
      input: { topic: "renewable energy adoption" },
    };
    const outcome1 = await agent1.processTask(task);
    assert.strictEqual(outcome1.status, "success");
    console.log("PASS: task completes normally with persistence enabled");

    const audit1Count = agent1.audit.all().length;
    const economics1 = agent1.economics.summary();
    assert.ok(audit1Count > 0);
    assert.ok(economics1.countsByType.task_completed >= 1);

    // Sanity: the data really did land on disk, not just in this instance's memory.
    assert.ok(fs.existsSync(path.join(dataDir, "memory-cache.json")));
    assert.ok(fs.existsSync(path.join(dataDir, "audit-log.jsonl")));
    assert.ok(fs.existsSync(path.join(dataDir, "economic-events.jsonl")));
    console.log("PASS: memory cache, audit log, and economic events are all actually written to disk");

    // --- "Process 2": simulate a full restart — brand-new agent instance, same directory ---
    const agent2 = new UniversalAgent({ persistDir: dataDir });

    // The audit log and economics history are immediately available, with no re-run needed.
    assert.strictEqual(agent2.audit.all().length, audit1Count, "audit history must survive the restart");
    assert.strictEqual(agent2.economics.summary().countsByType.task_completed, economics1.countsByType.task_completed, "economic history must survive the restart");
    console.log("PASS: a brand-new UniversalAgent instance immediately has the prior audit and economic history — this is real restart-survival");

    // The memory cache should now serve the SAME task from disk with zero new LLM calls.
    let llmCallsAfterRestart = 0;
    const originalGenerate = agent2.modelRouter.generate.bind(agent2.modelRouter);
    agent2.modelRouter.generate = async (...args) => {
      llmCallsAfterRestart++;
      return originalGenerate(...args);
    };

    const outcome2 = await agent2.processTask({ ...task, id: "restart-test-task-2" });
    assert.strictEqual(outcome2.meta.cached, true, "the second agent instance should serve this from the persisted cache");
    assert.strictEqual(llmCallsAfterRestart, 0, "no new LLM call should happen — the result came from disk, surviving the simulated restart");
    console.log("PASS: after a restart, a repeat task is served from the persisted cache with ZERO new LLM calls");
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("UniversalAgent restart-persistence test", async () => {
  await main();
});
