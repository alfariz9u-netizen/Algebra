"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PermissionSystem } = require("../src/core/permissionSystem");

test("permission grants are visible across separate instances sharing persistDir", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-perms-xproc-"));

  try {
    await t.test("a grant issued in one instance is seen by a second instance", () => {
      const instanceA = new PermissionSystem({ persistDir: dataDir });
      const instanceB = new PermissionSystem({ persistDir: dataDir });

      const deniedFirst = instanceB.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
      assert.strictEqual(deniedFirst.allowed, false);

      instanceA.grant({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL", durationMs: 60000 });

      const allowedNow = instanceB.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
      assert.strictEqual(allowedNow.allowed, true, "instance B must see the grant instance A just made, without re-granting itself");
    });

    await t.test("a revoke issued in one instance is honored by another instance immediately", () => {
      const instanceA = new PermissionSystem({ persistDir: dataDir });
      const instanceB = new PermissionSystem({ persistDir: dataDir });

      const grant = instanceA.grant({ agentId: "a2", taskId: "t2", resource: "t2", action: "PUBLISH", durationMs: 60000 });
      assert.strictEqual(instanceB.check({ agentId: "a2", taskId: "t2", resource: "t2", action: "PUBLISH" }).allowed, true);

      instanceB.revoke(grant.grantId);
      const afterRevoke = instanceA.check({ agentId: "a2", taskId: "t2", resource: "t2", action: "PUBLISH" });
      assert.strictEqual(afterRevoke.allowed, false, "instance A must see the revoke instance B just made");
    });

    await t.test("grants survive a restart (a brand-new instance still sees them)", () => {
      const instanceA = new PermissionSystem({ persistDir: dataDir });
      instanceA.grant({ agentId: "a3", taskId: "t3", resource: "t3", action: "READ_GITHUB", durationMs: 60000 });

      const restarted = new PermissionSystem({ persistDir: dataDir });
      assert.strictEqual(restarted.check({ agentId: "a3", taskId: "t3", resource: "t3", action: "READ_GITHUB" }).allowed, true);
    });

    await t.test("without persistDir, grants remain process-local only (documented, unchanged behavior)", () => {
      const localA = new PermissionSystem();
      const localB = new PermissionSystem();
      localA.grant({ agentId: "a4", taskId: "t4", resource: "t4", action: "SEND_EMAIL", durationMs: 60000 });
      assert.strictEqual(localB.check({ agentId: "a4", taskId: "t4", resource: "t4", action: "SEND_EMAIL" }).allowed, false);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
