"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const LearningEngine = require("../src/core/learningEngine");

test("circuit stays closed on a single transient-looking failure", () => {
  const learning = new LearningEngine({});
  const r = learning.recordFailure("openTask", "submitBid", new Error("ECONNRESET"));
  assert.strictEqual(r.opened, false);
  assert.strictEqual(learning.checkCircuit("openTask", "submitBid").open, false);
});

test("a config/auth failure opens the circuit immediately on the 2nd occurrence, not the 1st", () => {
  const learning = new LearningEngine({});
  const first = learning.recordFailure("openTask", "submitBid", new Error('OpenTask bid submission failed: 401 {"error":"Unauthorized"}'));
  assert.strictEqual(first.opened, false, "a single 401 should not yet open the circuit");
  assert.strictEqual(learning.checkCircuit("openTask", "submitBid").open, false);

  const second = learning.recordFailure("openTask", "submitBid", new Error("OpenTask bid submission failed: 401"));
  assert.strictEqual(second.opened, true, "a second consecutive 401 should open the circuit");
  const gate = learning.checkCircuit("openTask", "submitBid");
  assert.strictEqual(gate.open, true);
  assert.ok(gate.retryAfterMs > 0);
});

test("CREDENTIAL_REQUIRED / does-not-support errors open the circuit the same way", () => {
  const learning = new LearningEngine({});
  learning.recordFailure(
    "moltJobs",
    "discoverJobs",
    new Error('Connector "moltJobs" does not support "discoverJobs" right now (status: CREDENTIAL_REQUIRED).')
  );
  const stillClosed = learning.checkCircuit("moltJobs", "discoverJobs");
  assert.strictEqual(stillClosed.open, false, "first occurrence just increments the streak");

  learning.recordFailure(
    "moltJobs",
    "discoverJobs",
    new Error('Connector "moltJobs" does not support "discoverJobs" right now (status: CREDENTIAL_REQUIRED).')
  );
  const nowOpen = learning.checkCircuit("moltJobs", "discoverJobs");
  assert.strictEqual(nowOpen.open, true);
  assert.strictEqual(nowOpen.kind, "config");
});

test("a half-open trial that succeeds closes the circuit; a half-open trial that fails re-opens with a longer backoff", () => {
  const now = { t: 1_000_000 };
  const learning = new LearningEngine({ now: () => now.t });

  learning.recordFailure("openTask", "submitBid", new Error("401 Unauthorized"));
  learning.recordFailure("openTask", "submitBid", new Error("401 Unauthorized"));
  const opened = learning.checkCircuit("openTask", "submitBid");
  assert.strictEqual(opened.open, true);
  const firstBackoff = opened.retryAfterMs;

  // Jump past the backoff window — should become half-open (one trial allowed).
  now.t += firstBackoff + 1;
  const halfOpen = learning.checkCircuit("openTask", "submitBid");
  assert.strictEqual(halfOpen.open, false);
  assert.strictEqual(halfOpen.halfOpen, true);

  // The trial fails again — circuit re-opens with a LONGER backoff (exponential).
  const reopened = learning.recordFailure("openTask", "submitBid", new Error("401 Unauthorized"));
  assert.strictEqual(reopened.opened, true);
  assert.ok(reopened.retryAfterMs > firstBackoff, "backoff should grow after a failed half-open trial");

  // Now simulate credentials being fixed: jump forward again, and this time succeed.
  now.t += reopened.retryAfterMs + 1;
  assert.strictEqual(learning.checkCircuit("openTask", "submitBid").halfOpen, true);
  learning.recordSuccess("openTask", "submitBid");
  assert.strictEqual(learning.checkCircuit("openTask", "submitBid").open, false);
});

test("a listing-level defect (no usable budget) never opens the connector-wide circuit", () => {
  const learning = new LearningEngine({});
  const r = learning.recordFailure("agentMarket", "bidOnJob", new Error("Skipping bid on task xyz: no usable budget in the listing (raw.budget=undefined)"));
  assert.strictEqual(r.opened, false);
  assert.strictEqual(r.perListing, true);
  assert.strictEqual(learning.checkCircuit("agentMarket", "bidOnJob").open, false, "other listings on the same connector must still be attempted");
});

test("dead-opportunity memory skips a specific listing without affecting others", () => {
  const learning = new LearningEngine({});
  learning.markOpportunityDead("agentMarket", "f2a3e3ea-a172-4225-ab14-4b673d68cca1", "no usable budget");

  const { toProcess, skipped } = learning.partitionKnownDead("agentMarket", [
    { id: "f2a3e3ea-a172-4225-ab14-4b673d68cca1" },
    { id: "some-other-job" },
  ]);
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(toProcess.length, 1);
  assert.strictEqual(toProcess[0].id, "some-other-job");
});

test("calibrated success probability equals the fallback with zero data, and moves toward the observed rate with data", () => {
  const learning = new LearningEngine({});
  assert.ok(Math.abs(learning.calibratedSuccessProbability("moltMarket", 0.4) - 0.4) < 1e-9);

  for (let i = 0; i < 20; i++) learning.recordAttempt("moltMarket", { won: false });
  const calibrated = learning.calibratedSuccessProbability("moltMarket", 0.4);
  assert.ok(calibrated < 0.4, "20 consecutive losses should pull the estimate below the static 0.4 guess");
  assert.ok(calibrated >= 0.01, "should stay above the floor rather than collapsing to 0");
});

test("state survives a restart when persistDir is set", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "learning-engine-test-"));
  try {
    const a = new LearningEngine({ persistDir: dir });
    a.recordFailure("openTask", "submitBid", new Error("401 Unauthorized"));
    a.recordFailure("openTask", "submitBid", new Error("401 Unauthorized"));
    a.markOpportunityDead("agentMarket", "job-1", "no usable budget");

    const b = new LearningEngine({ persistDir: dir }); // simulates a fresh process
    assert.strictEqual(b.checkCircuit("openTask", "submitBid").open, true);
    assert.strictEqual(b.isOpportunityDead("agentMarket", "job-1"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("All learning engine tests defined — run via `node --test`.");
