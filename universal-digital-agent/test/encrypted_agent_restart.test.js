"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixtureServer } = require("./fixture_server");

async function main() {
  const port = 8945;
  const server = await createFixtureServer(port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-encrypted-agent-test-"));

  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.PERSIST_ENCRYPTION_KEY = "super-secret-deployment-passphrase";

  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");

  try {
    const agent1 = new UniversalAgent({ persistDir: dataDir });
    const task = {
      id: "encrypted-restart-task",
      type: "research_report",
      input: { topic: "a topic containing a fake secret: sk-ant-shouldnotleak12345" },
    };
    const outcome1 = await agent1.processTask(task);
    assert.strictEqual(outcome1.status, "success");
    console.log("PASS: task completes normally with encryption enabled");

    // --- Raw files on disk must not contain any recognizable plaintext ---
    const auditRaw = fs.readFileSync(path.join(dataDir, "audit-log.jsonl"), "utf8");
    const memoryRaw = fs.readFileSync(path.join(dataDir, "memory-cache.json"), "utf8");
    assert.ok(!auditRaw.includes("shouldnotleak"), "audit log on disk must not contain the raw task content");
    assert.ok(!memoryRaw.includes("shouldnotleak"), "memory cache on disk must not contain the raw task content");
    assert.ok(!auditRaw.includes("research_report") && !auditRaw.includes("CLASSIFY_INTENT"), "not even field names/action strings should be visible in ciphertext");
    console.log("PASS: the raw files on disk are genuinely encrypted — no plaintext task content or field names visible");

    // --- Restart with the SAME key: everything reloads correctly ---
    const agent2 = new UniversalAgent({ persistDir: dataDir });
    assert.strictEqual(agent2.audit.all().length, agent1.audit.all().length);
    console.log("PASS: restarting with the correct encryption key reloads audit history correctly");

    let llmCalls = 0;
    const originalGenerate = agent2.modelRouter.generate.bind(agent2.modelRouter);
    agent2.modelRouter.generate = async (...args) => {
      llmCalls++;
      return originalGenerate(...args);
    };
    const outcome2 = await agent2.processTask({ ...task, id: "encrypted-restart-task-2" });
    assert.strictEqual(outcome2.meta.cached, true);
    assert.strictEqual(llmCalls, 0);
    console.log("PASS: the encrypted memory cache still serves repeat tasks with zero new LLM calls after a restart");

    // --- Restart with the WRONG key: must fail loudly, never silently expose or lose data ---
    process.env.PERSIST_ENCRYPTION_KEY = "wrong-passphrase-entirely";
    delete require.cache[require.resolve("../src/core/universalAgent")];
    const UniversalAgent3 = require("../src/core/universalAgent");
    assert.throws(() => new UniversalAgent3({ persistDir: dataDir }), "loading encrypted state with the wrong key must throw, not silently start empty");
    console.log("PASS: attempting to load the same encrypted data with the wrong key throws rather than silently discarding it");
  } finally {
    server.close();
    delete process.env.PERSIST_ENCRYPTION_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("Encrypted UniversalAgent restart test", async () => {
  await main();
});
