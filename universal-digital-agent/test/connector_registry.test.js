"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { ConnectorRegistry, STATUS } = require("../src/core/connectorRegistry");

function main() {
  const registry = new ConnectorRegistry();

  registry.register("fakeConnected", {
    instance: {},
    capabilities: ["READ_PUBLIC_WEB"],
    statusFn: () => STATUS.CONNECTED,
  });
  registry.register("needsCreds", {
    instance: {},
    capabilities: ["SUBMIT_TASK"],
    statusFn: () => STATUS.CREDENTIAL_REQUIRED,
  });

  assert.strictEqual(registry.status("fakeConnected"), STATUS.CONNECTED);
  assert.strictEqual(registry.status("needsCreds"), STATUS.CREDENTIAL_REQUIRED);
  assert.strictEqual(registry.status("neverRegistered"), STATUS.NOT_SUPPORTED);
  console.log("PASS: registry reports each connector's real, distinct status");

  assert.strictEqual(registry.supports("fakeConnected", "READ_PUBLIC_WEB"), true);
  assert.strictEqual(registry.supports("needsCreds", "SUBMIT_TASK"), false, "not CONNECTED, so not supported yet");
  assert.strictEqual(registry.supports("fakeConnected", "SOME_OTHER_OP"), false, "operation not in its capability list");
  console.log("PASS: supports() never claims an operation works unless CONNECTED and declared");
}

test("Connector registry tests", async () => {
  main();
});
