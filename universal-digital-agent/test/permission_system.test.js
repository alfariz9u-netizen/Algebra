"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { PermissionSystem } = require("../src/core/permissionSystem");

function main() {
  const perms = new PermissionSystem();

  const denied = perms.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
  assert.strictEqual(denied.allowed, false);
  console.log("PASS: deny-by-default with no grant");

  perms.grant({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL", durationMs: 50 });
  const allowed = perms.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
  assert.strictEqual(allowed.allowed, true);
  console.log("PASS: explicit grant allows the action");

  perms.revoke(allowed.grant.grantId);
  const revoked = perms.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
  assert.strictEqual(revoked.allowed, false);
  console.log("PASS: revoked grant is denied");
}

test("Permission system tests", async () => {
  main();
});
