"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-retention-test-"));

  // ============ AuditLog pruning ============
  delete require.cache[require.resolve("../src/core/auditLog")];
  const { AuditLog } = require("../src/core/auditLog");
  const audit = new AuditLog({ persistDir: dir });

  // Manually backdate some entries to simulate old records.
  for (let i = 0; i < 5; i++) audit.record({ agentId: "a", taskId: `old-${i}`, action: "TEST" });
  audit.entries.forEach((e) => (e.timestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString())); // 10 days ago
  for (let i = 0; i < 3; i++) audit.record({ agentId: "a", taskId: `new-${i}`, action: "TEST" });

  assert.strictEqual(audit.all().length, 8);
  const auditPruneResult = audit.prune({ maxAgeMs: 24 * 60 * 60 * 1000 }); // keep only last 1 day
  assert.strictEqual(auditPruneResult.removed, 5);
  assert.strictEqual(audit.all().length, 3);
  console.log("PASS: AuditLog.prune() removes entries older than maxAgeMs, keeping only recent ones");

  // Reload from disk to prove the FILE itself was actually compacted, not just the in-memory array.
  const auditReloaded = new (require("../src/core/auditLog").AuditLog)({ persistDir: dir });
  assert.strictEqual(auditReloaded.all().length, 3, "the on-disk file must reflect the pruned state after restart");
  console.log("PASS: the audit log file on disk is genuinely compacted — a fresh instance sees only 3 entries, not 8");

  // ============ MemoryCache pruning ============
  delete require.cache[require.resolve("../src/core/memoryCache")];
  const MemoryCache = require("../src/core/memoryCache");
  const fakeModelRouter = { embed: async () => { throw new Error("no embeddings in this test"); } };
  const memory = new MemoryCache(fakeModelRouter, { persistDir: dir });

  await memory.store("research", "prompt-that-expires-immediately", "old result", { ttlMs: -1000, verificationStatus: "passed" });
  await memory.store("research", "prompt-that-is-fresh", "fresh result", { ttlMs: 60000, verificationStatus: "passed" });

  const memoryPruneResult = memory.pruneExpired();
  assert.strictEqual(memoryPruneResult.removedExact, 1, "the already-expired entry should be physically removed");
  console.log("PASS: MemoryCache.pruneExpired() physically removes expired entries, not just skips them at lookup");

  const stillThere = await memory.lookup("research", "prompt-that-is-fresh");
  assert.strictEqual(stillThere.hit, true, "the still-valid entry must survive pruning");
  console.log("PASS: pruning does not touch entries that are still within their TTL");

  // records[] cap
  for (let i = 0; i < 10; i++) {
    await memory.store("research", `prompt-${i}`, `result-${i}`, { ttlMs: 60000, verificationStatus: "passed" });
  }
  const beforeCount = memory.records.length;
  const capResult = memory.pruneExpired({ maxRecords: 5 });
  assert.strictEqual(memory.records.length, 5);
  assert.strictEqual(capResult.removedRecords, beforeCount - 5);
  console.log("PASS: pruneExpired({ maxRecords }) caps the full history log to the most recent N entries");

  // ============ EconomicIntelligence pruning (rollup-safe) ============
  delete require.cache[require.resolve("../src/core/economicIntelligence")];
  const EconomicIntelligence = require("../src/core/economicIntelligence");
  const econ = new EconomicIntelligence({ persistDir: dir });

  econ.record({ type: "task_completed", revenueUsd: 1.0, costUsd: 0.1 });
  econ.record({ type: "task_completed", revenueUsd: 2.0, costUsd: 0.2 });
  econ.events.forEach((e) => (e.timestamp = Date.now() - 10 * 24 * 60 * 60 * 1000)); // backdate both
  econ.record({ type: "task_completed", revenueUsd: 3.0, costUsd: 0.3 }); // recent, kept

  const summaryBeforePrune = econ.summary();
  assert.strictEqual(summaryBeforePrune.totalRevenueUsd, 6.0);
  console.log("PASS: summary() correctly totals revenue before any pruning");

  const econPruneResult = econ.prune({ maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.strictEqual(econPruneResult.removed, 2, "the two backdated events should be pruned");
  console.log("PASS: EconomicIntelligence.prune() removes old events");

  const summaryAfterPrune = econ.summary();
  assert.strictEqual(
    summaryAfterPrune.totalRevenueUsd,
    6.0,
    "CRITICAL: total revenue must NOT shrink after pruning — the pruned events' financial contribution must be preserved via rollup"
  );
  assert.ok(Math.abs(summaryAfterPrune.totalCostUsd - 0.6) < 1e-9);
  console.log("PASS: financial totals are exactly preserved after pruning, via the persisted rollup — no revenue history is silently lost");

  // Reload fresh: rollup must have survived on disk too.
  const econReloaded = new (require("../src/core/economicIntelligence"))({ persistDir: dir });
  assert.strictEqual(econReloaded.summary().totalRevenueUsd, 6.0, "the rollup must persist across a restart, not just within one process");
  console.log("PASS: the rollup itself survives a restart — pruned financial history is never lost, even across process restarts");

  // ============ _recordedFinancialTaskIds unbounded growth (FIX) ============
  // Small cap via env override so the test doesn't need 10,000+ real
  // records to exercise the eviction path.
  process.env.ECONOMICS_MAX_FINANCIAL_DEDUPE_KEYS = "5";
  delete require.cache[require.resolve("../src/core/economicIntelligence")];
  const EconomicIntelligenceCapped = require("../src/core/economicIntelligence");
  const dedupeDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-dedupe-cap-test-"));
  const econCapped = new EconomicIntelligenceCapped({ persistDir: dedupeDir });

  for (let i = 0; i < 8; i++) {
    econCapped.record({ type: "task_completed", taskId: `task-${i}`, revenueUsd: 1, costUsd: 0 });
  }
  assert.strictEqual(
    econCapped._recordedFinancialTaskIds.size,
    8,
    "the Set itself isn't capped on every record() — only prune() evicts, per the requirement"
  );

  const cappedPruneResult = econCapped.prune({ maxEntries: 1000 }); // no events are old/excess enough to remove by count/age
  assert.strictEqual(cappedPruneResult.dedupeKeysRemoved, 3, "prune() must evict exactly (size - cap) = 8 - 5 = 3 oldest keys");
  assert.strictEqual(econCapped._recordedFinancialTaskIds.size, 5, "the Set must be capped at the configured size after prune()");

  // The newest keys (task-3..task-7) must survive; the oldest (task-0..task-2) are evicted.
  for (let i = 3; i < 8; i++) {
    assert.ok(
      econCapped._recordedFinancialTaskIds.has(`task_completed:task-${i}`),
      `recent task-${i} must still be protected against duplicate recording after the cap is enforced`
    );
  }
  for (let i = 0; i < 3; i++) {
    assert.ok(!econCapped._recordedFinancialTaskIds.has(`task_completed:task-${i}`), `oldest task-${i} should have been evicted`);
  }

  // And recent dedupe protection genuinely still works post-eviction: a
  // duplicate recording of a SURVIVING taskId is still rejected.
  const dupeResult = econCapped.record({ type: "task_completed", taskId: "task-7", revenueUsd: 999, costUsd: 0 });
  assert.strictEqual(dupeResult.duplicate, true, "deduping of recent, still-tracked taskIds must not be lost after eviction");
  console.log("PASS: _recordedFinancialTaskIds is capped during prune(), evicting oldest-first, without losing dedup coverage for recent tasks");

  fs.rmSync(dedupeDir, { recursive: true, force: true });
  delete process.env.ECONOMICS_MAX_FINANCIAL_DEDUPE_KEYS;

  fs.rmSync(dir, { recursive: true, force: true });
}

test("Retention/pruning tests", async () => {
  await main();
});
