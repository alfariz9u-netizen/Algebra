"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const EconomicIntelligence = require("../src/core/economicIntelligence");

/** Independent, deliberately-naive reimplementation of the old O(n) rescan, used only to check the incremental version agrees with it. */
function naiveSummary(events, rollup) {
  const byType = { ...rollup.countsByType };
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  const completed = events.filter((e) => e.type === "task_completed");
  const revenue = rollup.totalRevenueUsd + completed.reduce((s, e) => s + (e.revenueUsd || 0), 0);
  const cost = rollup.totalCostUsd + completed.reduce((s, e) => s + (e.costUsd || 0), 0);
  return { countsByType: byType, totalRevenueUsd: revenue, totalCostUsd: cost, totalProfitUsd: revenue - cost };
}

test("EconomicIntelligence.summary() incremental aggregation matches a full rescan", async (t) => {
  await t.test("summary() after several record() calls matches naive rescan", () => {
    const econ = new EconomicIntelligence();
    econ.record({ type: "task_discovered", connector: "moltMarket" });
    econ.record({ type: "task_completed", connector: "moltMarket", model: "gemini-2.0-flash", revenueUsd: 5, costUsd: 0 });
    econ.record({ type: "task_completed", connector: "agenc", model: "grok-4", revenueUsd: 3, costUsd: 0.1 });
    econ.record({ type: "task_failed", connector: "openTask", model: "gemini-2.0-flash" });

    assert.deepStrictEqual(econ.summary(), naiveSummary(econ.events, econ.rollup));
    assert.strictEqual(econ.summary().totalRevenueUsd, 8);
    assert.strictEqual(econ.summary().totalProfitUsd, 7.9);
  });

  await t.test("summary() is O(1) per call — repeated calls don't re-scan events (behavioral proxy: results stay correct after many calls)", () => {
    const econ = new EconomicIntelligence();
    for (let i = 0; i < 500; i++) {
      econ.record({ type: "task_completed", revenueUsd: 1, costUsd: 0 });
    }
    // Call summary() many times; if it were silently re-deriving from a
    // stale/duplicated source it would drift. It must stay exactly correct.
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(econ.summary().totalRevenueUsd, 500);
    }
  });

  await t.test("after prune(), summary() totals are unchanged even though per-event detail is gone", () => {
    const econ = new EconomicIntelligence();
    const old = Date.now() - 1000 * 60 * 60 * 24 * 40; // 40 days ago
    econ.record({ type: "task_completed", revenueUsd: 10, costUsd: 1, timestamp: old });
    econ.record({ type: "task_completed", revenueUsd: 2, costUsd: 0 });

    const before = econ.summary();
    assert.strictEqual(before.totalRevenueUsd, 12);

    econ.prune({ maxAgeMs: 1000 * 60 * 60 * 24 * 30 }); // drop anything older than 30 days
    const after = econ.summary();

    assert.strictEqual(after.totalRevenueUsd, before.totalRevenueUsd, "pruning must never change lifetime totals");
    assert.strictEqual(after.totalProfitUsd, before.totalProfitUsd);
    assert.strictEqual(econ.events.length, 1, "the old event's per-event detail should actually be gone from memory");
  });

  await t.test("incremental totals survive a restart via persisted rollup + reloaded events", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-econ-incremental-"));
    try {
      const econ1 = new EconomicIntelligence({ persistDir: dataDir });
      econ1.record({ type: "task_completed", revenueUsd: 4, costUsd: 1 });
      econ1.prune({ maxAgeMs: 0 }); // force-fold everything into the rollup
      econ1.record({ type: "task_completed", revenueUsd: 6, costUsd: 0 });

      const econ2 = new EconomicIntelligence({ persistDir: dataDir });
      assert.deepStrictEqual(econ2.summary(), naiveSummary(econ2.events, econ2.rollup));
      assert.strictEqual(econ2.summary().totalRevenueUsd, 10);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
