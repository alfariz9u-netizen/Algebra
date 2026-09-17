"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const KillSwitch = require("../src/core/killSwitch");

/**
 * Regression test for the in-memory-only kill switch. The platform's own
 * docs run the agent and its CLIs as separate OS processes, so a kill
 * switch that only lives in one process's memory can't actually stop a
 * different process. Two separate KillSwitch instances pointed at the same
 * persistDir simulate that: instance B must see a stop triggered by
 * instance A.
 */
test("kill switch state is visible across separate instances sharing persistDir", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-killswitch-xproc-"));

  try {
    await t.test("a global stop in one instance is honored by a second instance", () => {
      const instanceA = new KillSwitch({ persistDir: dataDir });
      const instanceB = new KillSwitch({ persistDir: dataDir });

      instanceB.assertCanAct(); // not stopped yet
      instanceA.stopAll("operator emergency stop");

      assert.throws(
        () => instanceB.assertCanAct(),
        /GLOBAL_KILL_SWITCH/,
        "a stop issued in process A must be honored by process B without B ever calling stopAll itself"
      );
    });

    await t.test("resuming from either instance is honored by the other", () => {
      const instanceA = new KillSwitch({ persistDir: dataDir });
      const instanceB = new KillSwitch({ persistDir: dataDir });

      instanceB.resumeAll();
      instanceA.assertCanAct(); // must not throw anymore
    });

    await t.test("a per-connector stop is also visible across instances", () => {
      const instanceA = new KillSwitch({ persistDir: dataDir });
      const instanceB = new KillSwitch({ persistDir: dataDir });

      instanceA.stopConnector("github");
      assert.throws(() => instanceB.assertCanAct("github"), /github/);
      instanceB.assertCanAct("colony"); // unaffected connector, different key
    });

    await t.test("without persistDir, state is still process-local only (documented, unchanged behavior)", () => {
      const localA = new KillSwitch();
      const localB = new KillSwitch();
      localA.stopAll();
      localB.assertCanAct(); // must NOT throw — no shared persistence requested
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
