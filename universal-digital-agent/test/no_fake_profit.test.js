"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const EconomicIntelligence = require("../src/core/economicIntelligence");
const { classifyIncoming, runPaymentWatchCycle, scanWalletForPayments } = require("../src/core/paymentWatcher");

const strict = () => new EconomicIntelligence({ strictRevenue: true });

test("strict economics: task_completed can never carry revenue, whatever the caller passes", () => {
  const e = strict();
  e.record({ type: "task_completed", taskId: "t1", revenueUsd: 500, expectedRevenueUsd: 500, costUsd: 1 });
  const s = e.summary();
  assert.strictEqual(s.totalRevenueUsd, 0);
  assert.strictEqual(s.totalActualRevenueUsd, 0);
  assert.strictEqual(s.totalExpectedRevenueUsd, 500);
  assert.strictEqual(s.totalProfitUsd, -1, "cost is real, income is not");
});

test("strict economics: payment_received cannot be forged through record(); absurd rewards are capped", () => {
  const e = strict();
  assert.throws(() => e.record({ type: "payment_received", taskId: "x", amountUsd: 9999 }), /recordPayment/);
  e.record({ type: "task_completed", taskId: "t2", expectedRevenueUsd: 1e12 });
  e.record({ type: "task_completed", taskId: "t3", expectedRevenueUsd: NaN, costUsd: "abc" });
  const s = e.summary();
  assert.ok(s.totalExpectedRevenueUsd <= 10000);
  assert.ok(Number.isFinite(s.totalCostUsd));
  assert.strictEqual(s.totalRevenueUsd, 0);
});

test("strict economics: a real recordPayment is the only thing that creates revenue", () => {
  const e = strict();
  e.record({ type: "task_completed", taskId: "t4", expectedRevenueUsd: 20, costUsd: 0.5 });
  e.recordPayment({ taskId: "t4", amountUsd: 20, txSignature: "sig1" });
  const s = e.summary();
  assert.strictEqual(s.totalRevenueUsd, 20);
  assert.strictEqual(s.totalProfitUsd, 19.5);
  assert.strictEqual(s.pendingPaymentsUsd, 0);
});

test("watcher policy: own-wallet transfers, dust and (optionally) memo-less credits are not revenue", () => {
  const policy = { ownAddresses: new Set(["myotherwallet"]), minUsd: 0.01, requireTaskMatch: false };
  assert.strictEqual(classifyIncoming({ amountUsd: 5, from: "MyOtherWallet" }, policy).reason, "own_wallet");
  assert.strictEqual(classifyIncoming({ amountUsd: 0.0001, from: "x" }, policy).reason, "below_minimum");
  assert.strictEqual(classifyIncoming({ amountUsd: 5, from: "customer" }, policy).ok, true);
  assert.strictEqual(classifyIncoming({ amountUsd: 5, from: "customer", taskId: null }, { ...policy, requireTaskMatch: true }).reason, "no_task_memo");
});

test("watch cycle skips ignored transfers and records only the genuine one", async () => {
  const WALLET = "0x00000000000000000000000000000000000000ab";
  const mk = (hash, from, amount) => ({
    transactionHash: hash,
    logIndex: "0x0",
    data: "0x" + BigInt(amount * 1e6).toString(16).padStart(64, "0"),
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + from.padStart(64, "0"), "0x" + WALLET.slice(2).padStart(64, "0")],
  });
  const own = "1".repeat(40);
  let call = 0;
  const fetchImpl = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === "eth_blockNumber" ? "0x1c9c380" : call++ === 0 ? [mk("0xa", own, 40), mk("0xb", "2".repeat(40), 25), mk("0xc", "3".repeat(40), 0.0001)] : [];
    return { ok: true, json: async () => ({ result }) };
  };
  process.env.PAYMENT_WALLET_BASE = WALLET;
  delete process.env.PAYMENT_WALLET_SOLANA;
  try {
    const e = strict();
    const r = await runPaymentWatchCycle(e, { fetchImpl, policy: { ownAddresses: new Set(["0x" + own]), minUsd: 0.01, requireTaskMatch: false } });
    assert.strictEqual(r.recorded, 1);
    assert.deepStrictEqual(r.ignored.map((i) => i.reason).sort(), ["below_minimum", "own_wallet"]);
    assert.strictEqual(e.summary().totalRevenueUsd, 25);
  } finally {
    delete process.env.PAYMENT_WALLET_BASE;
  }
});

test("Base scan stays behind the chain tip (confirmations) and drops reorged-out logs", async () => {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_blockNumber") return { ok: true, json: async () => ({ result: "0x" + (1_000_000).toString(16) }) };
    seen.push(parseInt(params[0].toBlock, 16));
    return {
      ok: true,
      json: async () => ({ result: [{ removed: true, transactionHash: "0xr", logIndex: "0x0", data: "0x" + (1e6).toString(16).padStart(64, "0"), topics: ["0xt", "0x" + "1".padStart(64, "0")] }] }),
    };
  };
  const p = await scanWalletForPayments({ network: "base", walletAddress: "0x" + "ab".repeat(20), fetchImpl, confirmations: 12 });
  assert.strictEqual(p.length, 0);
  assert.ok(Math.max(...seen) <= 1_000_000 - 12);
});
