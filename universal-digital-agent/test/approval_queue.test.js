"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ApprovalQueue = require("../src/core/approvalQueue");
const { ConflictError } = ApprovalQueue;

function main() {
  const queue = new ApprovalQueue(); // in-memory, no persistDir

  const record = queue.enqueue({ taskId: "t1", task: { id: "t1" }, capability: "coding", action: "READ_FILES", riskLevel: "MEDIUM" });
  assert.strictEqual(record.status, "pending");
  assert.strictEqual(record.resumable, true);
  console.log("PASS: enqueue creates a pending, resumable record when a task is provided");

  assert.strictEqual(queue.list({ status: "pending" }).length, 1);
  assert.strictEqual(queue.list({ status: "approved" }).length, 0);
  console.log("PASS: list() filters correctly by status");

  const resolved = queue.resolve(record.id, "approved", "alice");
  assert.strictEqual(resolved.status, "approved");
  assert.strictEqual(resolved.resolvedBy, "alice");
  console.log("PASS: resolve() approves and records who resolved it");

  // FIX: the exact wording changed (now a ConflictError explaining WHY —
  // "expected pending, found approved" — rather than a bare "already
  // approved"), but the behavior this guards is unchanged and still
  // correct: resolving twice must still throw, not silently double-process.
  assert.throws(() => queue.resolve(record.id, "approved"), /expected "pending"/);
  console.log("PASS: resolving an already-resolved approval throws instead of silently double-processing");

  assert.throws(() => queue.resolve("nonexistent-id", "approved"), /No approval request/);
  console.log("PASS: resolving an unknown id throws a clear error");

  assert.throws(() => queue.resolve(record.id, "maybe"), /Invalid resolution status/);
  console.log("PASS: an invalid resolution status is rejected");

  const noTaskRecord = queue.enqueue({ taskId: "t2", connector: "moltMarket", action: "SUBMIT_TASK", riskLevel: "MEDIUM" });
  assert.strictEqual(noTaskRecord.resumable, false);
  console.log("PASS: an approval enqueued without a task is correctly marked not resumable");
}

test("ApprovalQueue tests", async () => {
  main();
});

test("REQUIREMENT: atomic claim/execute/consume lifecycle prevents approval replay", () => {
  const queue = new ApprovalQueue();
  const record = queue.enqueue({ taskId: "t3", task: { id: "t3" }, action: "SUBMIT_TASK", riskLevel: "MEDIUM" });
  queue.resolve(record.id, "approved", "alice");

  const claimed = queue.claim(record.id, "worker-A");
  assert.strictEqual(claimed.status, "claimed");
  assert.strictEqual(claimed.claimedBy, "worker-A");

  // The exact scenario this was built to prevent: a second, concurrent
  // caller trying to claim the SAME already-approved record.
  assert.throws(() => queue.claim(record.id, "worker-B"), ConflictError);
  assert.throws(() => queue.claim(record.id, "worker-B"), /expected "approved"/);

  const executing = queue.markExecuting(record.id, claimed.version);
  assert.strictEqual(executing.status, "executing");

  const consumed = queue.consume(record.id, executing.version, { taskStatus: "success" });
  assert.strictEqual(consumed.status, "consumed");
  assert.deepStrictEqual(consumed.result, { taskStatus: "success" });

  // Once consumed, it's terminal — forever. No replay, no re-claim, no
  // re-resolve, even though the id still exists and is still "valid".
  assert.throws(() => queue.claim(record.id, "worker-C"), /already "consumed"/);
  assert.throws(() => queue.resolve(record.id, "approved"), /already "consumed"/);
});

test("REQUIREMENT: a stale version is rejected even when the status check alone would have passed (optimistic concurrency / lost-update prevention)", () => {
  const queue = new ApprovalQueue();
  const record = queue.enqueue({ taskId: "t4", task: { id: "t4" }, action: "SUBMIT_TASK", riskLevel: "MEDIUM" });
  queue.resolve(record.id, "approved", "alice");
  const claimed = queue.claim(record.id, "worker-A");

  // Status is correctly "claimed" here, so a status-only check would let
  // this through — it's specifically the version mismatch that must
  // catch a caller acting on stale data (e.g. it read the record before
  // some OTHER concurrent field changed, even one that didn't flip
  // status). Passing an obviously-wrong version number directly isolates
  // that check from the status check.
  assert.throws(() => queue.markExecuting(record.id, claimed.version + 999), /modified concurrently/);

  // The correct version still works afterward — confirms the record
  // wasn't corrupted by the rejected attempt.
  const executing = queue.markExecuting(record.id, claimed.version);
  assert.strictEqual(executing.status, "executing");
});

test("REQUIREMENT: an execution failure is terminal (failed), distinct from success (consumed), and not silently retried", () => {
  const queue = new ApprovalQueue();
  const record = queue.enqueue({ taskId: "t5", task: { id: "t5" }, action: "SUBMIT_TASK", riskLevel: "MEDIUM" });
  queue.resolve(record.id, "approved", "alice");
  const claimed = queue.claim(record.id, "worker-A");
  const executing = queue.markExecuting(record.id, claimed.version);

  const failed = queue.fail(record.id, executing.version, "downstream API returned 500");
  assert.strictEqual(failed.status, "failed");
  assert.deepStrictEqual(failed.result, { error: "downstream API returned 500" });

  assert.throws(() => queue.claim(record.id, "worker-B"), /already "failed"/);
});

test("REQUIREMENT: state survives across independent ApprovalQueue instances pointed at the same persistDir — i.e. real cross-process safety, not just in-memory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-queue-cross-process-"));
  try {
    // Two separate instances with NO shared JS object — this is exactly
    // what "combinedServer.js's long-running process" and "a separate
    // `node approvalCli.js ...` invocation" look like.
    const processA = new ApprovalQueue({ persistDir: tmpDir });
    const record = processA.enqueue({ taskId: "t6", task: { id: "t6" }, action: "SUBMIT_TASK", riskLevel: "MEDIUM" });
    processA.resolve(record.id, "approved", "alice");

    const processB = new ApprovalQueue({ persistDir: tmpDir });
    const claimedByB = processB.claim(record.id, "worker-in-process-B");
    assert.strictEqual(claimedByB.status, "claimed");

    // Process A never refreshed its own stale in-memory copy — but every
    // mutating call re-reads from disk first, so it still sees reality,
    // not its stale cache, and correctly refuses to double-claim.
    assert.throws(() => processA.claim(record.id, "worker-in-process-A"), ConflictError);

    // And a THIRD instance (simulating, say, a cron job) sees the real
    // current state too.
    const processC = new ApprovalQueue({ persistDir: tmpDir });
    assert.strictEqual(processC.get(record.id).status, "claimed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
