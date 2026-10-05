"use strict";
/**
 * Memory-leak fix: `_recordedFinancialTaskIds` (the idempotency index for
 * financial events) used to be a Set that was never cleared. On a process
 * that runs for weeks (Render free plan, 512MB) it grew without bound until
 * the OOM killer stepped in. It is now a capped Map that prune() keeps in
 * sync with the retained events.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const EconomicIntelligence = require("../src/core/economicIntelligence");

const key = (i) => `task_completed:t${i}`;
const completed = (i) => ({ type: "task_completed", taskId: `t${i}`, revenueUsd: 0, expectedRevenueUsd: 1, costUsd: 0 });

/** Runs `fn` with MAX_FINANCIAL_IDS set (or unset when value === undefined), restoring the old value after. */
function withMaxEnv(value, fn) {
  const prev = process.env.MAX_FINANCIAL_IDS;
  if (value === undefined) delete process.env.MAX_FINANCIAL_IDS;
  else process.env.MAX_FINANCIAL_IDS = String(value);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MAX_FINANCIAL_IDS;
    else process.env.MAX_FINANCIAL_IDS = prev;
  }
}

/** Every key in the index must belong to an event that is still retained. */
function assertIndexSubsetOfEvents(econ) {
  const retained = new Set(econ.events.filter((e) => e.taskId).map((e) => `${e.type}:${e.taskId}`));
  for (const k of econ._recordedFinancialTaskIds.keys()) {
    assert.ok(retained.has(k), `index key ${k} has no retained event`);
  }
}

test("the idempotency index is a Map (insertion-ordered, with timestamps), not an unbounded Set", () => {
  const econ = new EconomicIntelligence();
  econ.record(completed(1));
  assert.ok(econ._recordedFinancialTaskIds instanceof Map);
  assert.strictEqual(typeof econ._recordedFinancialTaskIds.get(key(1)), "number", "each key maps to its event timestamp");
});

test("15,000 financial events + prune({ maxEntries: 5000 }): index shrinks to the retained events, recent ones stay protected, evicted ones can be re-added", () => {
  withMaxEnv(undefined, () => {
    const econ = new EconomicIntelligence();
    for (let i = 0; i < 15000; i++) econ.record(completed(i));
    assert.ok(econ._recordedFinancialTaskIds.size <= 10000, "capped even before any prune");

    const result = econ.prune({ maxEntries: 5000 });
    assert.strictEqual(result.after, 5000);
    assert.strictEqual(result.removed, 10000);

    const size = econ._recordedFinancialTaskIds.size;
    assert.ok(size <= 5000, `index size ${size} must be <= 5000 after prune`);
    assert.strictEqual(size, 5000, "it holds exactly the retained events' keys");
    assertIndexSubsetOfEvents(econ);

    // Recent events are still protected from double counting...
    const before = econ.summary();
    for (const i of [14999, 14000, 10000]) {
      const dup = econ.record(completed(i));
      assert.strictEqual(dup.duplicate, true, `t${i} is still retained, so a replay must be rejected`);
    }
    assert.deepStrictEqual(econ.summary(), before, "rejected replays must not change any total");

    // ...while a pruned event's key is gone, so it is not blocked any more.
    assert.strictEqual(econ._recordedFinancialTaskIds.has(key(0)), false);
    const readded = econ.record(completed(0));
    assert.strictEqual(readded.duplicate, undefined, "an event whose key was removed must be accepted again");
    assert.strictEqual(econ._recordedFinancialTaskIds.has(key(0)), true);

    // Pruning never loses lifetime totals: 15,000 originals, expected $1 each (+1 re-add).
    assert.strictEqual(econ.summary().totalExpectedRevenueUsd, 15001);
  });
});

test("hard cap: 12,000 financial events without any prune keep the index at 10,000 and drop the OLDEST", () => {
  withMaxEnv(undefined, () => {
    const econ = new EconomicIntelligence();
    for (let i = 0; i < 12000; i++) econ.record(completed(i));

    const ids = econ._recordedFinancialTaskIds;
    assert.ok(ids.size <= 10000);
    assert.strictEqual(ids.size, 10000);
    // The 2,000 oldest were evicted, the newest 10,000 remain.
    assert.strictEqual(ids.has(key(0)), false);
    assert.strictEqual(ids.has(key(1999)), false);
    assert.strictEqual(ids.has(key(2000)), true);
    assert.strictEqual(ids.has(key(11999)), true);
    // The newest are protected, the evicted are not.
    assert.strictEqual(econ.record(completed(11999)).duplicate, true);
    assert.strictEqual(econ.record(completed(0)).duplicate, undefined);
    // Events themselves are untouched by the cap (only the index is bounded).
    assert.strictEqual(econ.events.length, 12001);
  });
});

test("eviction order is oldest-first (cap = 3)", () => {
  const econ = new EconomicIntelligence({ maxFinancialIds: 3 });
  for (const i of [1, 2, 3, 4]) econ.record(completed(i));
  assert.deepStrictEqual([...econ._recordedFinancialTaskIds.keys()], [key(2), key(3), key(4)]);
  econ.record(completed(5));
  assert.deepStrictEqual([...econ._recordedFinancialTaskIds.keys()], [key(3), key(4), key(5)]);
});

test("MAX_FINANCIAL_IDS overrides the default; invalid values fall back to 10,000", () => {
  withMaxEnv(50, () => {
    const econ = new EconomicIntelligence();
    assert.strictEqual(econ._maxFinancialIds, 50);
    for (let i = 0; i < 80; i++) econ.record(completed(i));
    assert.strictEqual(econ._recordedFinancialTaskIds.size, 50);
    assert.strictEqual(econ._recordedFinancialTaskIds.has(key(79)), true);
    assert.strictEqual(econ._recordedFinancialTaskIds.has(key(29)), false);
  });
  for (const bad of ["abc", "0", "-5", ""]) {
    withMaxEnv(bad, () => {
      assert.strictEqual(new EconomicIntelligence()._maxFinancialIds, 10000, `MAX_FINANCIAL_IDS=${JSON.stringify(bad)} must fall back to the default`);
    });
  }
  withMaxEnv(undefined, () => {
    assert.strictEqual(new EconomicIntelligence()._maxFinancialIds, 10000);
    assert.strictEqual(new EconomicIntelligence({ maxFinancialIds: 7 })._maxFinancialIds, 7, "the constructor option wins over the default");
  });
});

test("prune({ maxAgeMs }) removes the keys of aged-out events and keeps the rest", () => {
  const econ = new EconomicIntelligence();
  const old = Date.now() - 1000 * 60 * 60 * 24 * 40;
  for (let i = 0; i < 10; i++) econ.record({ ...completed(i), timestamp: old });
  for (let i = 10; i < 15; i++) econ.record(completed(i));

  econ.prune({ maxAgeMs: 1000 * 60 * 60 * 24 * 30 });

  assert.strictEqual(econ._recordedFinancialTaskIds.size, 5);
  assertIndexSubsetOfEvents(econ);
  assert.strictEqual(econ._recordedFinancialTaskIds.has(key(3)), false);
  assert.strictEqual(econ._recordedFinancialTaskIds.has(key(12)), true);
});

test("payment_received keys are bounded and pruned like the other financial events", () => {
  const econ = new EconomicIntelligence({ maxFinancialIds: 5 });
  for (let i = 0; i < 8; i++) econ.recordPayment({ taskId: `p${i}`, amountUsd: 1 });
  assert.strictEqual(econ._recordedFinancialTaskIds.size, 5);
  assert.strictEqual(econ.recordPayment({ taskId: "p7", amountUsd: 1 }).duplicate, true);

  econ.prune({ maxEntries: 2 });
  assert.strictEqual(econ._recordedFinancialTaskIds.size, 2);
  assertIndexSubsetOfEvents(econ);
  assert.strictEqual(econ.summary().totalActualRevenueUsd, 8, "lifetime payments are preserved by the rollup");
});

test("a key evicted by the cap and re-recorded keeps its protection after prune() drops its older twin", () => {
  const econ = new EconomicIntelligence({ maxFinancialIds: 3 });
  for (const i of [1, 2, 3, 4]) econ.record(completed(i)); // t1's key is evicted
  const again = econ.record(completed(1)); // accepted: now two t1 events exist
  assert.strictEqual(again.duplicate, undefined);
  assert.strictEqual(econ.events.length, 5);

  econ.prune({ maxEntries: 3 }); // drops the old t1 and t2, keeps t3, t4 and the NEW t1
  assertIndexSubsetOfEvents(econ);
  assert.strictEqual(econ.record(completed(1)).duplicate, true, "the retained t1 must still be protected");
});

test("the index state after prune() matches what a restart rebuilds from the rewritten log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-financial-ids-"));
  try {
    const a = new EconomicIntelligence({ persistDir: dir });
    for (let i = 0; i < 40; i++) a.record(completed(i));
    a.prune({ maxEntries: 10 });
    assert.strictEqual(a._recordedFinancialTaskIds.size, 10);

    const b = new EconomicIntelligence({ persistDir: dir });
    assert.deepStrictEqual([...b._recordedFinancialTaskIds.keys()], [...a._recordedFinancialTaskIds.keys()]);
    // Compare totals BEFORE touching b again (re-adding an event below legitimately changes them).
    assert.deepStrictEqual(b.summary(), a.summary(), "lifetime totals (live + rollup) are identical after a restart");
    assert.strictEqual(b.record(completed(39)).duplicate, true, "retained event still protected after restart");
    assert.strictEqual(b.record(completed(0)).duplicate, undefined, "pruned event is no longer blocked after restart");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on startup the index is rebuilt from history but still respects the cap (newest kept)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-financial-ids-cap-"));
  try {
    const a = new EconomicIntelligence({ persistDir: dir });
    for (let i = 0; i < 20; i++) a.record(completed(i));

    const b = new EconomicIntelligence({ persistDir: dir, maxFinancialIds: 5 });
    assert.strictEqual(b._recordedFinancialTaskIds.size, 5);
    assert.deepStrictEqual([...b._recordedFinancialTaskIds.keys()], [key(15), key(16), key(17), key(18), key(19)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-financial events and events without a taskId never enter the index", () => {
  const econ = new EconomicIntelligence();
  econ.record({ type: "task_discovered", taskId: "x", connector: "a" });
  econ.record({ type: "task_completed", revenueUsd: 0 }); // no taskId: not deduplicated (existing behaviour)
  econ.record({ type: "task_completed", revenueUsd: 0 });
  assert.strictEqual(econ._recordedFinancialTaskIds.size, 0);
  assert.strictEqual(econ.events.length, 3);
});
