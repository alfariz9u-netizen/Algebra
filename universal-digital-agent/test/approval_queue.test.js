"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const ApprovalQueue = require("../src/core/approvalQueue");

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

  assert.throws(() => queue.resolve(record.id, "approved"), /already "approved"/);
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
