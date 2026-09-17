"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const KillSwitch = require("../src/core/killSwitch");

function main() {
  const ks = new KillSwitch();
  ks.assertCanAct(); // should not throw
  console.log("PASS: acting is allowed when switch is off");

  ks.stopAll("test stop");
  assert.throws(() => ks.assertCanAct(), /GLOBAL_KILL_SWITCH/);
  console.log("PASS: global kill switch blocks all actions");

  ks.resumeAll();
  ks.stopConnector("github");
  assert.throws(() => ks.assertCanAct("github"), /github/);
  ks.assertCanAct("colony"); // should not throw — different connector
  console.log("PASS: per-connector stop only blocks that connector");
}

test("Kill switch tests", async () => {
  main();
});
