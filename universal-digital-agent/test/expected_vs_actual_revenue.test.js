"use strict";
/**
 * Phantom-profit fix: "expected" (advertised reward) is kept apart from
 * "actual" (payment really received).
 *
 * Before: completing a $10 task recorded revenueUsd=10, so the dashboard
 * showed $10.10 while the Solana wallet was empty. Now:
 *   - task_completed => revenueUsd: 0, expectedRevenueUsd: <reward>
 *   - only economics.recordPayment() increases totalActualRevenueUsd
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixtureServer } = require("./fixture_server");
const EconomicIntelligence = require("../src/core/economicIntelligence");

const TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

test("completing a $10 task does NOT increase totalActualRevenueUsd (agent end-to-end)", async () => {
  const port = 8961;
  const server = await createFixtureServer(port);
  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.AUTONOMY_LEVEL = "2";
  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");

  try {
    const agent = new UniversalAgent();
    const before = agent.dashboard();
    assert.strictEqual(before.totalActualRevenueUsd, 0);

    const result = await agent.processTask({
      id: "paid-task-1",
      type: "research_report",
      input: { topic: "expected versus received revenue" },
      rewardUsd: 10,
    });
    assert.strictEqual(result.status, "success");

    // The recorded event: reward is an expectation, not revenue.
    const completed = agent.economics.events.find((e) => e.type === "task_completed" && e.taskId === "paid-task-1");
    assert.ok(completed, "a task_completed event must be recorded");
    assert.strictEqual(completed.revenueUsd, 0, "revenueUsd must be 0: nothing was paid yet");
    assert.strictEqual(completed.expectedRevenueUsd, 10, "the advertised reward goes into expectedRevenueUsd");

    const summary = agent.economics.summary();
    assert.strictEqual(summary.totalActualRevenueUsd, 0, "completing a task must not count as received money");
    assert.strictEqual(summary.totalExpectedRevenueUsd, 10);
    assert.strictEqual(summary.pendingPaymentsUsd, 10);
    assert.strictEqual(summary.totalRevenueUsd, 0, "legacy total must not show phantom revenue either");

    // dashboard(): the three new fields are exposed explicitly (and inside `economics`).
    const dash = agent.dashboard();
    assert.strictEqual(dash.totalExpectedRevenueUsd, 10);
    assert.strictEqual(dash.totalActualRevenueUsd, 0);
    assert.strictEqual(dash.pendingPaymentsUsd, 10);
    assert.strictEqual(dash.economics.totalActualRevenueUsd, 0);

    // A real payment moves money from "pending" to "actual".
    agent.economics.recordPayment({ taskId: "paid-task-1", amountUsd: 10, txSignature: TX, connector: "opentask" });
    const dashAfter = agent.dashboard();
    assert.strictEqual(dashAfter.totalActualRevenueUsd, 10);
    assert.strictEqual(dashAfter.totalExpectedRevenueUsd, 10);
    assert.strictEqual(dashAfter.pendingPaymentsUsd, 0);
  } finally {
    server.close();
  }
});

test("a task without a reward records expectedRevenueUsd: 0", async () => {
  const econ = new EconomicIntelligence();
  econ.record({ type: "task_completed", taskId: "free-1", revenueUsd: 0, expectedRevenueUsd: 0, costUsd: 0.01 });
  const s = econ.summary();
  assert.strictEqual(s.totalExpectedRevenueUsd, 0);
  assert.strictEqual(s.totalActualRevenueUsd, 0);
  assert.strictEqual(s.pendingPaymentsUsd, 0);
});

test("recordPayment($10) increases totalActualRevenueUsd by exactly $10 and stores txSignature in metadata", () => {
  const econ = new EconomicIntelligence();
  econ.record({ type: "task_completed", taskId: "t1", revenueUsd: 0, expectedRevenueUsd: 10, costUsd: 0 });
  assert.strictEqual(econ.summary().totalActualRevenueUsd, 0);

  const entry = econ.recordPayment({ taskId: "t1", amountUsd: 10, txSignature: TX, connector: "opentask" });

  assert.strictEqual(entry.type, "payment_received");
  assert.strictEqual(entry.taskId, "t1");
  assert.strictEqual(entry.amountUsd, 10);
  assert.strictEqual(entry.connector, "opentask");
  assert.strictEqual(entry.metadata.txSignature, TX, "tx signature must be kept so it can be checked on Solscan");

  const s = econ.summary();
  assert.strictEqual(s.totalActualRevenueUsd, 10);
  assert.strictEqual(s.totalExpectedRevenueUsd, 10);
  assert.strictEqual(s.pendingPaymentsUsd, 0);
  assert.strictEqual(s.countsByType.payment_received, 1);
  // The backward-compatible profit figure now reflects the real payment.
  assert.strictEqual(s.totalRevenueUsd, 10);
  assert.strictEqual(s.totalProfitUsd, 10);
});

test("recordPayment twice with the same taskId is rejected as a duplicate (no double counting)", () => {
  const econ = new EconomicIntelligence();
  const first = econ.recordPayment({ taskId: "t1", amountUsd: 10, txSignature: TX });
  assert.strictEqual(first.duplicate, undefined);

  const second = econ.recordPayment({ taskId: "t1", amountUsd: 10, txSignature: "another-signature" });
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.type, "payment_received");
  assert.strictEqual(second.taskId, "t1");

  assert.strictEqual(econ.summary().totalActualRevenueUsd, 10, "the duplicate must not add a second $10");
  assert.strictEqual(econ.events.filter((e) => e.type === "payment_received").length, 1, "the duplicate must not be written");
  assert.strictEqual(econ.events[0].metadata.txSignature, TX, "the original signature is kept");

  // A different task is a different payment.
  econ.recordPayment({ taskId: "t2", amountUsd: 5 });
  assert.strictEqual(econ.summary().totalActualRevenueUsd, 15);
});

test("a payment and a completion for the same taskId do not collide (different event types)", () => {
  const econ = new EconomicIntelligence();
  econ.record({ type: "task_completed", taskId: "same", expectedRevenueUsd: 4 });
  const pay = econ.recordPayment({ taskId: "same", amountUsd: 4 });
  assert.strictEqual(pay.duplicate, undefined);
  assert.strictEqual(econ.summary().pendingPaymentsUsd, 0);
});

test("recordPayment validates its input", () => {
  const econ = new EconomicIntelligence();
  assert.throws(() => econ.recordPayment({ amountUsd: 5 }), /taskId is required/);
  assert.throws(() => econ.recordPayment({ taskId: "x" }), /amountUsd/);
  assert.throws(() => econ.recordPayment({ taskId: "x", amountUsd: 0 }), /amountUsd/);
  assert.throws(() => econ.recordPayment({ taskId: "x", amountUsd: -3 }), /amountUsd/);
  assert.throws(() => econ.recordPayment({ taskId: "x", amountUsd: NaN }), /amountUsd/);
  assert.throws(() => econ.recordPayment({ taskId: "x", amountUsd: "10" }), /amountUsd/);
  assert.throws(() => econ.recordPayment(), /taskId is required/);
  assert.strictEqual(econ.events.length, 0, "rejected payments must write nothing");
  assert.strictEqual(econ.summary().totalActualRevenueUsd, 0);
});

test("summary(): expected / actual / pending are separate and partial payments leave the remainder pending", () => {
  const econ = new EconomicIntelligence();
  econ.record({ type: "task_completed", taskId: "a", expectedRevenueUsd: 10, revenueUsd: 0 });
  econ.record({ type: "task_completed", taskId: "b", expectedRevenueUsd: 0.1, revenueUsd: 0 });
  econ.record({ type: "task_completed", taskId: "c", expectedRevenueUsd: 0.2, revenueUsd: 0 });
  econ.recordPayment({ taskId: "a", amountUsd: 4 });

  const s = econ.summary();
  assert.strictEqual(s.totalExpectedRevenueUsd, 10.3, "0.1 + 0.2 must not leak float noise");
  assert.strictEqual(s.totalActualRevenueUsd, 4);
  assert.strictEqual(s.pendingPaymentsUsd, 6.3);
});

test("pendingPaymentsUsd never goes negative (a payment for a task that was never recorded as completed)", () => {
  const econ = new EconomicIntelligence();
  econ.recordPayment({ taskId: "orphan", amountUsd: 7 });
  const s = econ.summary();
  assert.strictEqual(s.totalActualRevenueUsd, 7);
  assert.strictEqual(s.totalExpectedRevenueUsd, 0);
  assert.strictEqual(s.pendingPaymentsUsd, 0);
});

test("after prune(), totalExpectedRevenueUsd / totalActualRevenueUsd / pendingPaymentsUsd are NOT reduced", () => {
  const econ = new EconomicIntelligence();
  const old = Date.now() - 1000 * 60 * 60 * 24 * 40; // 40 days ago
  econ.record({ type: "task_completed", taskId: "old-1", expectedRevenueUsd: 10, revenueUsd: 0, costUsd: 0.5, timestamp: old });
  econ.record({ type: "task_completed", taskId: "old-2", expectedRevenueUsd: 6, revenueUsd: 0, timestamp: old });
  econ.record({ type: "payment_received", taskId: "old-1", amountUsd: 10, metadata: { txSignature: TX }, timestamp: old });
  econ.record({ type: "task_completed", taskId: "new-1", expectedRevenueUsd: 3, revenueUsd: 0 });
  econ.recordPayment({ taskId: "new-1", amountUsd: 1 });

  const before = econ.summary();
  assert.strictEqual(before.totalExpectedRevenueUsd, 19);
  assert.strictEqual(before.totalActualRevenueUsd, 11);
  assert.strictEqual(before.pendingPaymentsUsd, 8);

  const result = econ.prune({ maxAgeMs: 1000 * 60 * 60 * 24 * 30 });
  assert.strictEqual(result.removed, 3, "the three 40-day-old events are physically gone");

  const after = econ.summary();
  assert.strictEqual(after.totalExpectedRevenueUsd, before.totalExpectedRevenueUsd, "pruning must not lose expected revenue");
  assert.strictEqual(after.totalActualRevenueUsd, before.totalActualRevenueUsd, "pruning must not lose received payments");
  assert.strictEqual(after.pendingPaymentsUsd, before.pendingPaymentsUsd);
  assert.deepStrictEqual(after, before, "the whole summary is unchanged by pruning");

  // Prune everything via maxEntries too.
  econ.prune({ maxEntries: 1 });
  assert.deepStrictEqual(econ.summary(), before);
});

test("expected/actual totals survive prune + restart through the persisted rollup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-expected-actual-"));
  try {
    const a = new EconomicIntelligence({ persistDir: dir });
    a.record({ type: "task_completed", taskId: "p1", expectedRevenueUsd: 10, revenueUsd: 0 });
    a.recordPayment({ taskId: "p1", amountUsd: 10, txSignature: TX });
    a.record({ type: "task_completed", taskId: "p2", expectedRevenueUsd: 5, revenueUsd: 0 });
    a.prune({ maxEntries: 1 }); // folds p1's completion + payment into the rollup
    a.recordPayment({ taskId: "p2", amountUsd: 2 });
    const expected = a.summary();
    assert.strictEqual(expected.totalExpectedRevenueUsd, 15);
    assert.strictEqual(expected.totalActualRevenueUsd, 12);
    assert.strictEqual(expected.pendingPaymentsUsd, 3);

    const b = new EconomicIntelligence({ persistDir: dir });
    assert.deepStrictEqual(b.summary(), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rollup file written by the previous version (no expected/payments counters) still loads cleanly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-legacy-rollup-"));
  try {
    fs.writeFileSync(
      path.join(dir, "economic-rollup.json"),
      JSON.stringify({ countsByType: { task_completed: 3 }, totalRevenueUsd: 10.1, totalCostUsd: 0.1 })
    );
    const econ = new EconomicIntelligence({ persistDir: dir });
    const s = econ.summary();
    assert.strictEqual(s.totalExpectedRevenueUsd, 0);
    assert.strictEqual(s.totalActualRevenueUsd, 0);
    assert.strictEqual(s.pendingPaymentsUsd, 0);
    assert.ok(Number.isFinite(s.totalRevenueUsd), "no NaN from the missing counters");
    assert.strictEqual(s.totalRevenueUsd, 10.1, "the legacy figure is preserved as-is, not silently rewritten");

    econ.recordPayment({ taskId: "n1", amountUsd: 2 });
    assert.strictEqual(econ.summary().totalActualRevenueUsd, 2);
    assert.ok(Number.isFinite(econ.summary().totalExpectedRevenueUsd));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("payment_received events are idempotent across a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-payment-restart-"));
  try {
    const a = new EconomicIntelligence({ persistDir: dir });
    a.recordPayment({ taskId: "r1", amountUsd: 10, txSignature: TX });

    const b = new EconomicIntelligence({ persistDir: dir });
    const again = b.recordPayment({ taskId: "r1", amountUsd: 10, txSignature: TX });
    assert.strictEqual(again.duplicate, true, "a replayed payment after a restart must still be rejected");
    assert.strictEqual(b.summary().totalActualRevenueUsd, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
