"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixtureServer } = require("./fixture_server");

/**
 * Regression test for the "deny-by-default permission system is decorative"
 * fix. Previously, UniversalAgent.processTask() self-granted the
 * capability's permission BEFORE checking whether the action's risk level
 * required human approval — so the permission check always trivially
 * passed, no matter the risk level. The fix reorders the gate so a
 * permission is only ever self-authorized for an action that has already
 * cleared the risk/autonomy gate (LOW risk, or explicitly approved).
 *
 * This test proves the ordering directly: when a MEDIUM-risk task is held
 * for approval, NO permission grant must exist for it yet.
 */
test("risk/autonomy gate runs before permission self-authorization", async (t) => {
  const port = 8955;
  const server = await createFixtureServer(port);
  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.AUTONOMY_LEVEL = "0"; // MANUAL — MEDIUM/HIGH risk always held

  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");

  try {
    await t.test("a MEDIUM-risk task is held for approval with no permission grant issued", async () => {
      const agent = new UniversalAgent({ agentId: "gate-order-test" });
      const task = {
        id: "gate-order-task-1",
        type: "communication", // MEDIUM risk capability (SEND_MESSAGE)
        input: { context: "A customer asked about refund policy.", goal: "Draft a reply." },
      };

      const result = await agent.processTask(task);
      assert.strictEqual(result.status, "pending_human_approval");

      // The key regression check: no permission grant should exist for this
      // exact agent/task/action, because the gate must run BEFORE grant().
      const permCheck = agent.permissions.check({
        agentId: agent.agentId,
        taskId: task.id,
        resource: task.id,
        action: "SEND_MESSAGE",
      });
      assert.strictEqual(
        permCheck.allowed,
        false,
        "no permission should have been self-granted for a task still awaiting human approval"
      );
      assert.match(permCheck.reason, /No grant exists/);
    });

    await t.test("a LOW-risk task is self-authorized and actually runs (gate correctly lets it through)", async () => {
      const agent = new UniversalAgent({ agentId: "gate-order-test-2" });
      const task = {
        id: "gate-order-task-2",
        type: "research", // LOW risk capability (READ_PUBLIC_WEB), never held for approval
        input: { topic: "history of the sextant" },
      };

      const result = await agent.processTask(task);
      assert.strictEqual(result.status, "success", "a LOW-risk task must not be blocked");

      const permCheck = agent.permissions.check({
        agentId: agent.agentId,
        taskId: task.id,
        resource: task.id,
        action: "READ_PUBLIC_WEB",
      });
      assert.strictEqual(permCheck.allowed, true, "a LOW-risk task's action is self-authorized once it clears the gate");
    });

    await t.test("resuming an approved task self-authorizes only at resume time, not before", async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-gate-order-"));
      try {
        const agent = new UniversalAgent({ agentId: "gate-order-test-3", persistDir: dataDir });
        const task = {
          id: "gate-order-task-3",
          type: "communication",
          input: { context: "x", goal: "y" },
        };

        const pending = await agent.processTask(task);
        assert.strictEqual(pending.status, "pending_human_approval");

        const beforeApproval = agent.permissions.check({
          agentId: agent.agentId,
          taskId: task.id,
          resource: task.id,
          action: "SEND_MESSAGE",
        });
        assert.strictEqual(beforeApproval.allowed, false, "still not granted while pending");

        agent.approvals.resolve(pending.approvalId, "approved", "reviewer");
        const finalResult = await agent.resumeTask(pending.approvalId);
        assert.strictEqual(finalResult.status, "success");

        const afterApproval = agent.permissions.check({
          agentId: agent.agentId,
          taskId: task.id,
          resource: task.id,
          action: "SEND_MESSAGE",
        });
        assert.strictEqual(afterApproval.allowed, true, "granted only once the approval gate was actually cleared");
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  } finally {
    server.close();
  }
});
