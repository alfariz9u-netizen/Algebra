"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixtureServer } = require("./fixture_server");

async function main() {
  const port = 8944;
  const server = await createFixtureServer(port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-approval-test-"));

  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.AUTONOMY_LEVEL = "0"; // MANUAL — everything needs approval

  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");

  try {
    // --- "Agent process": discovers a task that needs a MEDIUM-risk capability (communication), gets held ---
    const agentProcess = new UniversalAgent({ persistDir: dataDir });
    const task = {
      id: "needs-approval-task",
      type: "communication",
      input: { context: "A customer asked about refund policy.", goal: "Draft a helpful, professional reply." },
    };

    const initialResult = await agentProcess.processTask(task);
    assert.strictEqual(initialResult.status, "pending_human_approval");
    assert.ok(initialResult.approvalId, "a real, resumable approval record must be created, not just a status string");
    console.log("PASS: a MEDIUM-risk task at autonomy 0 is held with a real, trackable approval id");

    const approvalId = initialResult.approvalId;

    // Confirm it's really on disk, not just in that process's memory.
    assert.ok(fs.existsSync(path.join(dataDir, "approvals.json")));
    console.log("PASS: the pending approval is actually persisted to disk");

    // --- "CLI / human, in a different process": loads the SAME queue from disk, approves it ---
    delete require.cache[require.resolve("../src/core/approvalQueue")];
    const ApprovalQueue = require("../src/core/approvalQueue");
    const humanSideQueue = new ApprovalQueue({ persistDir: dataDir });

    const pendingList = humanSideQueue.list({ status: "pending" });
    assert.strictEqual(pendingList.length, 1);
    assert.strictEqual(pendingList[0].id, approvalId, "the human, in a completely separate ApprovalQueue instance, sees the exact same pending request");
    console.log("PASS: a brand-new ApprovalQueue instance (simulating the CLI) sees the pending approval created by the other process");

    humanSideQueue.resolve(approvalId, "approved", "human-reviewer");
    console.log("PASS: the human approves it");

    // --- Resuming: a THIRD agent instance (simulating the CLI's `resume` command) actually executes it ---
    delete require.cache[require.resolve("../src/core/universalAgent")];
    const UniversalAgent2 = require("../src/core/universalAgent");
    const resumingAgent = new UniversalAgent2({ persistDir: dataDir });

    const finalResult = await resumingAgent.resumeTask(approvalId);
    assert.strictEqual(finalResult.status, "success", "resuming an approved task must actually execute it via a real LLM call, not just flip a flag");
    assert.ok(finalResult.output.length > 0);
    console.log("PASS: resumeTask() on a brand-new agent instance actually runs the original task to completion");

    // --- Safety: denied approvals must never be resumable into execution ---
    const secondTask = { id: "denied-task", type: "communication", input: { context: "x", goal: "y" } };
    const secondPending = await resumingAgent.processTask(secondTask);
    resumingAgent.approvals.resolve(secondPending.approvalId, "denied", "human-reviewer");
    const deniedResume = await resumingAgent.resumeTask(secondPending.approvalId);
    assert.strictEqual(deniedResume.status, "denied");
    console.log("PASS: attempting to resume a DENIED approval never executes the task");

    // --- Safety: a still-pending approval cannot be resumed as if approved ---
    const thirdTask = { id: "still-pending-task", type: "communication", input: { context: "x", goal: "y" } };
    const thirdPending = await resumingAgent.processTask(thirdTask);
    const stillPendingResume = await resumingAgent.resumeTask(thirdPending.approvalId);
    assert.strictEqual(stillPendingResume.status, "pending");
    console.log("PASS: attempting to resume a still-pending (unresolved) approval does not execute it either");
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("Human approval workflow test", async () => {
  await main();
});
