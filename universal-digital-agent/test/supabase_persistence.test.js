"use strict";
/**
 * State survives a redeploy that wipes Render's ephemeral disk because it is
 * mirrored to Supabase (economic events, approvals, learning state, moltbook
 * post state) — and nothing breaks when Supabase is down (local fallback).
 *
 * "Restart" below = a NEW instance with a NEW EMPTY persistDir, i.e. exactly
 * what a redeploy does to the container's disk, pointed at the same Supabase.
 * Supabase itself is an in-process fake (test/fixtures/fake_supabase.js).
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { startFakeSupabase } = require("./fixtures/fake_supabase");
const EconomicIntelligence = require("../src/core/economicIntelligence");
const ApprovalQueue = require("../src/core/approvalQueue");
const { ConflictError } = ApprovalQueue;
const LearningEngine = require("../src/core/learningEngine");

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-persist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function withFake(t) {
  const fake = await startFakeSupabase();
  t.after(() => fake.close());
  useEnv(t, { SUPABASE_URL: fake.url, SUPABASE_SERVICE_KEY: fake.key, SUPABASE_STATE_RECONCILE_MS: "3600000" });
  return fake;
}

// ---------------------------------------------------------------- economics

test("economic events survive a restart (new instance, empty disk) via Supabase", async (t) => {
  const fake = await withFake(t);

  const a = new EconomicIntelligence({ persistDir: tmpDir(t) });
  await a.init();
  a.record({ type: "task_completed", taskId: "t1", connector: "openTask", model: "m1", revenueUsd: 0, costUsd: 2, expectedRevenueUsd: 10 });
  a.record({ type: "task_failed", taskId: "t2", connector: "openTask" });
  a.recordPayment({ taskId: "t1", amountUsd: 10, txSignature: "sig-1", network: "base", token: "USDC" });
  await a.flush();

  assert.strictEqual(fake.tables.economic_events.size, 3);
  const payRow = [...fake.tables.economic_events.values()].find((r) => r.type === "payment_received");
  assert.strictEqual(payRow.tx_signature, "sig-1");
  assert.strictEqual(payRow.amount_usd, 10);
  assert.deepStrictEqual(payRow.metadata, { txSignature: "sig-1", network: "base", token: "USDC", from: null }); // fields without a column keep their value

  const b = new EconomicIntelligence({ persistDir: tmpDir(t) }); // fresh, empty disk
  assert.strictEqual(b.summary().totalRevenueUsd, 0, "nothing before init(): the disk really was wiped");
  await b.init();

  const s = b.summary();
  assert.strictEqual(s.totalRevenueUsd, 10, "real revenue = the payment");
  assert.strictEqual(s.totalCostUsd, 2);
  assert.strictEqual(s.totalActualRevenueUsd, 10);
  assert.strictEqual(s.totalExpectedRevenueUsd, 10);
  assert.strictEqual(s.pendingPaymentsUsd, 0);
  assert.strictEqual(s.countsByType.task_completed, 1);
  assert.strictEqual(s.countsByType.task_failed, 1);
  assert.strictEqual(b.bestPlatform().connector, "openTask");
});

test("recordPayment is idempotent by task (and tx_signature) across restarts and racing processes", async (t) => {
  const fake = await withFake(t);

  const a = new EconomicIntelligence({ persistDir: tmpDir(t) });
  await a.init();
  a.recordPayment({ taskId: "pay-1", amountUsd: 5, txSignature: "sig-dup" });
  await a.flush();

  // After a restart the watcher re-scans the same tx: duplicate, nothing written.
  const b = new EconomicIntelligence({ persistDir: tmpDir(t) });
  await b.init();
  assert.strictEqual(b.recordPayment({ taskId: "pay-1", amountUsd: 5, txSignature: "sig-dup" }).duplicate, true);
  await b.flush();
  assert.strictEqual([...fake.tables.economic_events.values()].filter((r) => r.tx_signature === "sig-dup").length, 1);

  // A process that hasn't loaded Supabase yet records it again: the UNIQUE tx_signature
  // index rejects it and the local double count is rolled back.
  const c = new EconomicIntelligence({ persistDir: tmpDir(t) });
  const entry = c.recordPayment({ taskId: "pay-1", amountUsd: 5, txSignature: "sig-dup" });
  assert.ok(!entry.duplicate);
  assert.strictEqual(c.summary().totalActualRevenueUsd, 5, "counted optimistically at first");
  await c.flush();
  assert.strictEqual(c.summary().totalActualRevenueUsd, 0, "rolled back once Supabase said it already had it");
  assert.strictEqual([...fake.tables.economic_events.values()].length, 1);

  assert.throws(() => b.recordPayment({ amountUsd: 5 }), /taskId is required/);
});

test("prune() folds into the rollup atomically in Supabase and totals survive a restart", async (t) => {
  const fake = await withFake(t);
  const a = new EconomicIntelligence({ persistDir: tmpDir(t) });
  await a.init();
  for (let i = 0; i < 5; i++) a.record({ type: "task_completed", taskId: `p${i}`, revenueUsd: 2, costUsd: 1 });
  await a.flush();

  const res = a.prune({ maxEntries: 2 });
  assert.strictEqual(res.removed, 3);
  await a.flush();
  assert.strictEqual(fake.tables.economic_events.size, 2);
  assert.strictEqual(fake.tables.economic_rollup.get(1).data.totalRevenueUsd, 6);

  const b = new EconomicIntelligence({ persistDir: tmpDir(t) });
  await b.init();
  assert.strictEqual(b.summary().totalRevenueUsd, 10, "pruned detail is gone, lifetime totals are not");
  assert.strictEqual(b.summary().totalCostUsd, 5);
  assert.strictEqual(b.events.length, 2);
});

// ---------------------------------------------------------------- approvals

test("an approval survives a restart, and exactly one process can claim it (UPDATE ... WHERE version = X)", async (t) => {
  const fake = await withFake(t);

  const a = new ApprovalQueue({ persistDir: tmpDir(t) });
  await a.init();
  const rec = a.enqueue({ taskId: "task-9", task: { id: "task-9", type: "x" }, capability: "cap", connector: "openTask", action: "PUBLISH", riskLevel: "MEDIUM" });
  a.resolve(rec.id, "approved", "tester");
  await a.flush();

  const row = fake.tables.approvals.get(rec.id);
  assert.strictEqual(row.status, "approved");
  assert.strictEqual(row.version, 2);
  assert.deepStrictEqual(row.task, { id: "task-9", type: "x" });
  assert.strictEqual(row.risk_level, "MEDIUM");

  // Two fresh processes (empty disks) both load it and race to claim it.
  const b = new ApprovalQueue({ persistDir: tmpDir(t) });
  const c = new ApprovalQueue({ persistDir: tmpDir(t) });
  await Promise.all([b.init(), c.init()]);
  assert.strictEqual(b.get(rec.id).status, "approved");
  assert.strictEqual(b.get(rec.id).resumable, true);

  const results = await Promise.allSettled([b.claimRemote(rec.id, "proc-b"), c.claimRemote(rec.id, "proc-c")]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.strictEqual(won.length, 1, "exactly one claimant wins");
  assert.strictEqual(lost.length, 1);
  assert.ok(lost[0].reason instanceof ConflictError);
  assert.strictEqual(fake.tables.approvals.get(rec.id).status, "claimed");
  assert.strictEqual(fake.tables.approvals.get(rec.id).version, 3);
  assert.ok(["proc-b", "proc-c"].includes(fake.tables.approvals.get(rec.id).claimed_by));

  // Terminal states never come back.
  const winner = won[0].value;
  const owner = winner.claimedBy === "proc-b" ? b : c;
  const executing = owner.markExecuting(rec.id, winner.version);
  owner.consume(rec.id, executing.version, { ok: true });
  await owner.flush();
  assert.strictEqual(fake.tables.approvals.get(rec.id).status, "consumed");
  await assert.rejects(() => c.claimRemote(rec.id, "late"), ConflictError);
});

test("a stuck 'executing' approval is still reaped (_reapStuckExecuting) and the failure is replicated", async (t) => {
  const fake = await withFake(t);
  fake.tables.approvals.set("stuck-1", {
    id: "stuck-1", task_id: "t", task: { id: "t" }, capability: null, connector: null, action: "PUBLISH", risk_level: "LOW",
    status: "executing", version: 4, requested_at: new Date(Date.now() - 7200000).toISOString(), resolved_at: null, resolved_by: null,
    claimed_at: null, claimed_by: null, executing_at: new Date(Date.now() - 3600000).toISOString(), consumed_at: null, result: null,
  });

  const q = new ApprovalQueue({ persistDir: tmpDir(t) });
  await q.init();
  const rec = q.get("stuck-1"); // every read path reaps
  assert.strictEqual(rec.status, "failed");
  assert.match(rec.result.error, /timed out/);
  await q.flush();
  assert.strictEqual(fake.tables.approvals.get("stuck-1").status, "failed");
  assert.strictEqual(fake.tables.approvals.get("stuck-1").version, 5);
});

// ----------------------------------------------------------------- learning

test("learning state (circuits, dead opportunities, connector stats) survives a restart", async (t) => {
  const fake = await withFake(t);
  const now = () => 1_700_000_000_000;

  const a = new LearningEngine({ persistDir: tmpDir(t), now });
  await a.init();
  for (let i = 0; i < 3; i++) a.recordFailure("openTask", "submitBid", new Error("503 service unavailable"));
  a.markOpportunityDead("openTask", "task-dead", "no usable reward");
  a.recordAttempt("openTask", { won: true });
  a.recordAttempt("openTask", { won: false });
  await a.flush();

  assert.deepStrictEqual(Object.keys(Object.fromEntries([...fake.tables.learning_state].map(([k]) => [k, 1]))).sort(), ["circuits", "connectorStats", "deadOpportunities"]);

  const b = new LearningEngine({ persistDir: tmpDir(t), now }); // wiped disk
  assert.strictEqual(b.isOpportunityDead("openTask", "task-dead"), false, "empty before init()");
  await b.init();

  assert.strictEqual(b.isOpportunityDead("openTask", "task-dead"), true);
  assert.strictEqual(b.checkCircuit("openTask", "submitBid").open, true, "the open circuit is still open");
  assert.deepStrictEqual(b.status().connectorStats.openTask, { attempts: 2, wins: 1 });
});

test("learning reads use the in-memory cache: no Supabase query per call", async (t) => {
  const fake = await withFake(t);
  const a = new LearningEngine({ persistDir: tmpDir(t) });
  await a.init();
  const before = fake.requests.filter((r) => r.method === "GET").length;
  for (let i = 0; i < 50; i++) {
    a.checkCircuit("x", "y");
    a.isOpportunityDead("x", String(i));
    a.calibratedSuccessProbability("x", 0.5);
  }
  assert.strictEqual(fake.requests.filter((r) => r.method === "GET").length, before);
});

// ----------------------------------------------------------- moltbook state

test("moltbook post state (lastPostAt + title hashes) survives a restart", async (t) => {
  const fake = await withFake(t);

  const load = (dir) => {
    useEnv(t, { PERSIST_DIR: dir });
    delete require.cache[require.resolve("../src/core/universalAgent")];
    const UniversalAgent = require("../src/core/universalAgent");
    return new UniversalAgent({ persistDir: dir });
  };

  const a = load(tmpDir(t));
  await a.ready;
  a._moltbookPostState.lastPostAt = 1_760_000_000_000;
  a._moltbookPostState.titleHashes.add("hash-aaa");
  a._saveMoltbookState();
  await a.flushState();
  assert.strictEqual(fake.tables.moltbook_state.get("post_state").value.lastPostAt, 1_760_000_000_000);

  const b = load(tmpDir(t)); // redeploy: empty disk
  assert.strictEqual(b._moltbookPostState.lastPostAt, 0);
  await b.ready;
  assert.strictEqual(b._moltbookPostState.lastPostAt, 1_760_000_000_000, "the 30-minute cooldown is not forgotten");
  assert.ok(b._moltbookPostState.titleHashes.has("hash-aaa"));
});

// ----------------------------------------------------------------- fallback

test("Supabase down: everything keeps working from the local files, then catches up when it recovers", async (t) => {
  const fake = await withFake(t);
  fake.setFailing(true); // every request -> 503

  const dir = tmpDir(t);
  const econ = new EconomicIntelligence({ persistDir: dir });
  const approvals = new ApprovalQueue({ persistDir: dir });
  const learning = new LearningEngine({ persistDir: dir });
  // Fast failures: the real client retries; keep the test quick.
  for (const q of [econ._queue, approvals._queue, learning._queue]) q._retryDelayMs = 1;

  const warn = t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(async () => {
    await Promise.all([econ.init(), approvals.init(), learning.init()]);
    econ.record({ type: "task_completed", taskId: "down-1", revenueUsd: 0, expectedRevenueUsd: 7, costUsd: 1 });
    econ.recordPayment({ taskId: "down-1", amountUsd: 7, txSignature: "sig-down" });
    const rec = approvals.enqueue({ taskId: "down-t", task: { id: "down-t" }, action: "PUBLISH", riskLevel: "LOW" });
    approvals.resolve(rec.id, "approved", "tester");
    const claimed = await approvals.claimRemote(rec.id, "me"); // Supabase unreachable -> local claim
    assert.strictEqual(claimed.status, "claimed");
    learning.markOpportunityDead("openTask", "down-task", "x");
    await Promise.all([econ.flush(), approvals.flush(), learning.flush()]);
  });
  assert.ok(warn.mock.calls.length > 0, "failures are logged, not thrown");

  // In-memory + local files are intact:
  assert.strictEqual(econ.summary().totalRevenueUsd, 7);
  assert.strictEqual(new EconomicIntelligence({ persistDir: dir }).summary().totalActualRevenueUsd, 7, "the local file has it");
  assert.strictEqual(new ApprovalQueue({ persistDir: dir }).list({ status: "claimed" }).length, 1);
  assert.strictEqual(new LearningEngine({ persistDir: dir }).isOpportunityDead("openTask", "down-task"), true);
  assert.strictEqual(fake.tables.economic_events.size, 0, "nothing reached Supabase yet");

  // Supabase recovers: the queued re-sync pushes what it missed.
  fake.setFailing(false);
  assert.strictEqual(await econ._queue.reconcileNow(), true);
  assert.strictEqual(await approvals._queue.reconcileNow(), true);
  assert.strictEqual(await learning._queue.reconcileNow(), true);
  assert.strictEqual(fake.tables.economic_events.size, 2);
  assert.strictEqual(fake.tables.approvals.size, 1);
  assert.ok(fake.tables.learning_state.has("deadOpportunities"));

  // ...and a wiped-disk restart now sees all of it.
  const restarted = new EconomicIntelligence({ persistDir: tmpDir(t) });
  await restarted.init();
  assert.strictEqual(restarted.summary().totalRevenueUsd, 7);
});

test("Supabase unreachable at startup (connection refused) or wrong key: no crash, local mode", async (t) => {
  useEnv(t, { SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_KEY: "k", SUPABASE_STATE_RECONCILE_MS: "3600000", SUPABASE_STATE_TIMEOUT_MS: "500" });
  t.mock.method(console, "warn", () => {});
  const econ = new EconomicIntelligence({ persistDir: tmpDir(t) });
  econ._queue._retryDelayMs = 1;
  await assert.doesNotReject(() => econ.init());
  econ.record({ type: "task_completed", taskId: "x", revenueUsd: 1 });
  await econ.flush();
  assert.strictEqual(econ.summary().totalRevenueUsd, 1);

  const fake = await startFakeSupabase();
  t.after(() => fake.close());
  useEnv(t, { SUPABASE_URL: fake.url, SUPABASE_SERVICE_KEY: "WRONG-KEY" });
  const econ2 = new EconomicIntelligence({ persistDir: tmpDir(t) });
  await assert.doesNotReject(() => econ2.init());
  econ2.record({ type: "task_completed", taskId: "y", revenueUsd: 3 });
  await econ2.flush();
  assert.strictEqual(econ2.summary().totalRevenueUsd, 3);
  assert.strictEqual(fake.tables.economic_events.size, 0, "401 from Supabase: nothing stored, nothing thrown");
});

test("without SUPABASE_URL/SUPABASE_SERVICE_KEY nothing changes (pure local mode, no network)", async (t) => {
  useEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined });
  const real = global.fetch;
  global.fetch = async () => {
    throw new Error("no network expected");
  };
  t.after(() => {
    global.fetch = real;
  });
  const dir = tmpDir(t);
  const econ = new EconomicIntelligence({ persistDir: dir });
  await econ.init();
  econ.record({ type: "task_completed", taskId: "local", revenueUsd: 4 });
  assert.strictEqual(new EconomicIntelligence({ persistDir: dir }).summary().totalRevenueUsd, 4);
  const q = new ApprovalQueue({ persistDir: dir });
  const rec = q.enqueue({ taskId: "t", action: "PUBLISH", riskLevel: "LOW" });
  q.resolve(rec.id, "approved");
  assert.strictEqual((await q.claimRemote(rec.id, "me")).status, "claimed");
});
