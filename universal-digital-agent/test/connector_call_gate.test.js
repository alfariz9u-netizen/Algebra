"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const UniversalAgent = require("../src/core/universalAgent");

test("callConnector security gate tests", async (t) => {
  const agent = new UniversalAgent();
  let callCount = 0;
  const fakeConnector = { doThing: async () => { callCount++; return "ok"; } };

  await t.test("callConnector refuses an operation the connector didn't declare, without running it", async () => {
      agent.connectors.register("fakeConn", {
        instance: fakeConnector,
        capabilities: ["SEND_MESSAGE"],
        statusFn: () => "CONNECTED",
      });
      agent.rateLimiter = new (require("../src/core/rateLimiter"))({ capacity: 2, refillPerSecond: 0 });

      // 1. Unsupported operation is refused outright, never attempted.
      await assert.rejects(
        () => agent.callConnector("fakeConn", "SOME_UNDECLARED_OP", "SEND_MESSAGE", fakeConnector.doThing),
        /does not support/
      );
      assert.strictEqual(callCount, 0, "the underlying function must never run for an unsupported operation");
  });

  await t.test("a supported, allowed operation runs and is audited as SUCCESS", async () => {
    // 2. Register the operation properly now, and confirm it runs and is audited.
      agent.connectors.register("fakeConn", {
        instance: fakeConnector,
        capabilities: ["SEND_MESSAGE", "REAL_OP"],
        statusFn: () => "CONNECTED",
      });

      const result = await agent.callConnector("fakeConn", "REAL_OP", "SEND_MESSAGE", fakeConnector.doThing);
      assert.strictEqual(result, "ok");
      assert.strictEqual(callCount, 1);
      const successEntry = agent.audit.all().find((e) => e.action === "REAL_OP" && e.result === "SUCCESS");
      assert.ok(successEntry, "successful connector call must be audited");
  });

  await t.test("repeated calls to the same connector are eventually rate-limited", async () => {
    // 3. Rate limit: capacity 2, already consumed 1 above -> 1 more allowed, then blocked.
      await agent.callConnector("fakeConn", "REAL_OP", "SEND_MESSAGE", fakeConnector.doThing);
      await assert.rejects(
        () => agent.callConnector("fakeConn", "REAL_OP", "SEND_MESSAGE", fakeConnector.doThing),
        /Rate limit exceeded/
      );
  });

  await t.test("kill switch blocks connector calls immediately, before any other check", async () => {
    // 4. Kill switch blocks everything immediately, regardless of rate-limit state.
      const agent2 = new UniversalAgent();
      agent2.connectors.register("fakeConn2", {
        instance: fakeConnector,
        capabilities: ["REAL_OP"],
        statusFn: () => "CONNECTED",
      });
      agent2.killSwitch.stopAll("test");
      await assert.rejects(
        () => agent2.callConnector("fakeConn2", "REAL_OP", "SEND_MESSAGE", fakeConnector.doThing),
        /GLOBAL_KILL_SWITCH/
      );
  });

});
