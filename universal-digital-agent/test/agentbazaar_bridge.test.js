"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BRIDGE_SCRIPT = path.join(__dirname, "..", "src", "connectors", "python_bridge", "agentbazaar_bridge.py");
const FAKE_PACKAGE_DIR = path.join(__dirname, "fixtures", "fake_agentsbazaar");

function runBridge(command, { env = {} } = {}) {
  const logPath = fs.mkdtempSync(path.join(os.tmpdir(), "agentbazaar-call-log-")) + "/call.json";
  const result = spawnSync("python3", [BRIDGE_SCRIPT, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: FAKE_PACKAGE_DIR, // our fake `agentsbazaar` module wins over any real one
      CALL_LOG_PATH: logPath,
      ...env,
    },
  });
  let loggedCall = null;
  try {
    loggedCall = JSON.parse(fs.readFileSync(logPath, "utf8"));
  } catch {
    /* command may have failed before constructing the client — fine, caller checks result */
  }
  return { result, loggedCall };
}

test("FIX (AgentBazaar #308): the bridge passes an explicit base_url to SyncAgentBazaarClient, avoiding the redirect", () => {
  const { result, loggedCall } = runBridge("list_agents");
  assert.strictEqual(result.status, 0, `bridge should exit cleanly; stderr: ${result.stderr}`);
  const stdout = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.strictEqual(stdout.ok, true);

  assert.ok(loggedCall, "SyncAgentBazaarClient must actually have been constructed");
  assert.strictEqual(
    loggedCall.base_url,
    "https://agentbazaar.dev",
    "must default to the real API host, not leave base_url unset (which was redirecting with a 308)"
  );
});

test("FIX (AgentBazaar #308): AGENTBAZAAR_API_URL overrides the default base_url", () => {
  const { result, loggedCall } = runBridge("stats", { env: { AGENTBAZAAR_API_URL: "https://staging.agentbazaar.dev" } });
  assert.strictEqual(result.status, 0, `bridge should exit cleanly; stderr: ${result.stderr}`);
  assert.strictEqual(loggedCall.base_url, "https://staging.agentbazaar.dev");
});

test("FIX (AgentBazaar #308): the 'call' command (which also needs a keypair) still passes base_url", () => {
  const { result, loggedCall } = runBridge("call");
  // args defaults to {} since no json_args were passed — that's fine, we
  // only care that base_url made it through to the client constructor.
  assert.strictEqual(result.status, 0, `bridge should exit cleanly; stderr: ${result.stderr}`);
  assert.strictEqual(loggedCall.base_url, "https://agentbazaar.dev");
  assert.strictEqual(loggedCall.keypair, "fake-keypair");
});
