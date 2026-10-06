"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withCwd(dir, fn) {
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prevCwd);
  }
}

test("FIX (PERSIST_DIR consistency): buildAgent() warns loudly and falls back to './data' when PERSIST_DIR is unset", () => {
  const prevPersistDir = process.env.PERSIST_DIR;
  delete process.env.PERSIST_DIR;

  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "persist-dir-warn-"));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);

  try {
    withCwd(tmpCwd, () => {
      delete require.cache[require.resolve("../src/index")];
      const { buildAgent } = require("../src/index");

      assert.ok(
        warnings.some((w) => w.includes("PERSIST_DIR is not set")),
        "must warn explicitly when PERSIST_DIR is missing, not fail silently"
      );
      assert.ok(warnings.some((w) => w.includes("ephemeral")), "the warning should explain WHY this matters (Render's ephemeral disk)");

      const agent = buildAgent();
      assert.strictEqual(agent.persistDir, "./data", "must default to './data', matching every other module's own independent default");

      // And it must be a REAL, working default — not just a string label.
      // approvals/economics/learning/audit must actually persist to that
      // directory, not silently stay in-memory-only.
      agent.approvals.enqueue({ taskId: "t1", task: { id: "t1" }, action: "SUBMIT_TASK", riskLevel: "MEDIUM" });
      assert.ok(fs.existsSync(path.join(tmpCwd, "data", "approvals.json")), "approvals must actually be written under the resolved default directory");
    });
  } finally {
    console.warn = originalWarn;
    if (prevPersistDir === undefined) delete process.env.PERSIST_DIR;
    else process.env.PERSIST_DIR = prevPersistDir;
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});

test("FIX (PERSIST_DIR consistency): when PERSIST_DIR IS set, buildAgent() uses it exactly, with no warning", () => {
  const prevPersistDir = process.env.PERSIST_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-dir-explicit-"));
  process.env.PERSIST_DIR = tmpDir;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);

  try {
    delete require.cache[require.resolve("../src/index")];
    const { buildAgent } = require("../src/index");

    assert.ok(!warnings.some((w) => w.includes("PERSIST_DIR is not set")), "must not warn when PERSIST_DIR is explicitly set");

    const agent = buildAgent();
    assert.strictEqual(agent.persistDir, tmpDir);

    agent.approvals.enqueue({ taskId: "t2", task: { id: "t2" }, action: "SUBMIT_TASK", riskLevel: "MEDIUM" });
    assert.ok(fs.existsSync(path.join(tmpDir, "approvals.json")), "approvals must be written under the EXPLICIT directory, not './data'");
  } finally {
    console.warn = originalWarn;
    if (prevPersistDir === undefined) delete process.env.PERSIST_DIR;
    else process.env.PERSIST_DIR = prevPersistDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("FIX (PERSIST_DIR consistency): the Telegram bot's agent (via buildAgent) and the main server's agent (via buildAgent) genuinely share one directory", () => {
  const prevPersistDir = process.env.PERSIST_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-dir-shared-"));
  process.env.PERSIST_DIR = tmpDir;

  try {
    delete require.cache[require.resolve("../src/index")];
    const { buildAgent } = require("../src/index");

    // Two independent calls — simulating combinedServer.js's own agent and
    // a freshly-built one for a Telegram command — must land on the same
    // real directory, not two different silently-defaulted paths.
    const serverAgent = buildAgent();
    const telegramAgent = buildAgent();
    assert.strictEqual(serverAgent.persistDir, telegramAgent.persistDir);
    assert.strictEqual(serverAgent.persistDir, tmpDir);
  } finally {
    if (prevPersistDir === undefined) delete process.env.PERSIST_DIR;
    else process.env.PERSIST_DIR = prevPersistDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
