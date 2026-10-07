"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanWalletForPayments, runPaymentWatchCycle, TOKENS, extractTaskId } = require("../src/core/paymentWatcher");
const EconomicIntelligence = require("../src/core/economicIntelligence");

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"; // a syntactically-plausible but not-real Solana address, fixture-only
const TOKEN_ACCOUNT = "F1etQvK9Jmra7XTS4aMz1cFzNT6qvQyfmX4jBaDXoxqe";

function jsonRpcResponder(handlers) {
  // `handlers` maps RPC method name -> (params) => result
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const handler = handlers[body.method];
    if (!handler) throw new Error(`Unmocked RPC method in test: ${body.method}`);
    const result = await handler(body.params);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: body.id, result }) };
  };
}

test("scanWalletForPayments(solana): detects a real incoming USDC transfer, extracts the memo-based taskId", async () => {
  const fetchImpl = jsonRpcResponder({
    getTokenAccountsByOwner: () => ({ value: [{ pubkey: TOKEN_ACCOUNT }] }),
    getSignaturesForAddress: () => [{ signature: "sig-incoming-1", err: null, blockTime: Math.floor(Date.now() / 1000) - 60 }],
    getTransaction: () => ({
      meta: {
        preTokenBalances: [{ owner: WALLET, mint: TOKENS.solana.usdc.mint, uiTokenAmount: { uiAmount: 10 } }],
        postTokenBalances: [{ owner: WALLET, mint: TOKENS.solana.usdc.mint, uiTokenAmount: { uiAmount: 17.5 } }],
      },
      transaction: {
        message: {
          instructions: [{ program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: "task:job-42" }],
        },
      },
    }),
  });

  const payments = await scanWalletForPayments({ network: "solana", walletAddress: WALLET, tokens: ["usdc"], fetchImpl });
  assert.strictEqual(payments.length, 1);
  assert.strictEqual(payments[0].amountUsd, 7.5, "must compute the real balance delta (17.5 - 10), not the post-balance alone");
  assert.strictEqual(payments[0].taskId, "job-42", "must extract the taskId from the real on-chain memo");
  assert.strictEqual(payments[0].txSignature, "sig-incoming-1");
  assert.strictEqual(payments[0].network, "solana");
});

test("scanWalletForPayments(solana): an OUTGOING transfer (negative delta) is never reported as a payment", async () => {
  const fetchImpl = jsonRpcResponder({
    getTokenAccountsByOwner: () => ({ value: [{ pubkey: TOKEN_ACCOUNT }] }),
    getSignaturesForAddress: () => [{ signature: "sig-outgoing-1", err: null, blockTime: Math.floor(Date.now() / 1000) }],
    getTransaction: () => ({
      meta: {
        preTokenBalances: [{ owner: WALLET, mint: TOKENS.solana.usdc.mint, uiTokenAmount: { uiAmount: 20 } }],
        postTokenBalances: [{ owner: WALLET, mint: TOKENS.solana.usdc.mint, uiTokenAmount: { uiAmount: 15 } }],
      },
      transaction: { message: { instructions: [] } },
    }),
  });
  const payments = await scanWalletForPayments({ network: "solana", walletAddress: WALLET, tokens: ["usdc"], fetchImpl });
  assert.strictEqual(payments.length, 0, "we sent money out — this must not be recorded as money coming in");
});

test("scanWalletForPayments(solana): a transaction outside the lookback window is skipped", async () => {
  const fetchImpl = jsonRpcResponder({
    getTokenAccountsByOwner: () => ({ value: [{ pubkey: TOKEN_ACCOUNT }] }),
    getSignaturesForAddress: () => [
      { signature: "sig-too-old", err: null, blockTime: Math.floor(Date.now() / 1000) - 48 * 3600 }, // 48h ago
    ],
    getTransaction: () => {
      throw new Error("getTransaction must not even be called for a signature outside the lookback window");
    },
  });
  const payments = await scanWalletForPayments({
    network: "solana",
    walletAddress: WALLET,
    tokens: ["usdc"],
    lookbackHours: 24,
    fetchImpl,
  });
  assert.strictEqual(payments.length, 0);
});

test("scanWalletForPayments(solana): a failed transaction (err set) is skipped — nothing real moved", async () => {
  const fetchImpl = jsonRpcResponder({
    getTokenAccountsByOwner: () => ({ value: [{ pubkey: TOKEN_ACCOUNT }] }),
    getSignaturesForAddress: () => [{ signature: "sig-failed", err: { InstructionError: [0, "Custom"] }, blockTime: Math.floor(Date.now() / 1000) }],
    getTransaction: () => {
      throw new Error("getTransaction must not be called for a failed signature");
    },
  });
  const payments = await scanWalletForPayments({ network: "solana", walletAddress: WALLET, tokens: ["usdc"], fetchImpl });
  assert.strictEqual(payments.length, 0);
});

test("scanWalletForPayments(base): decodes a real ERC-20 Transfer log into a USD amount", async () => {
  const toAddress = "0x000000000000000000000000000000000000ab";
  const fetchImpl = jsonRpcResponder({
    eth_blockNumber: () => "0x" + (30_000_000).toString(16),
    eth_getLogs: () => [
      {
        transactionHash: "0xabc123",
        logIndex: "0x0",
        data: "0x00000000000000000000000000000000000000000000000000000002faf080", // 50,000,000 (6-decimal USDC) = 50.0
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x000000000000000000000000111111111111111111111111111111111111aa", // from
          "0x000000000000000000000000000000000000000000000000000000000000ab", // to (our wallet, padded)
        ],
      },
    ],
  });

  const payments = await scanWalletForPayments({ network: "base", walletAddress: toAddress, tokens: ["usdc"], fetchImpl });
  assert.strictEqual(payments.length, 1);
  assert.strictEqual(payments[0].amountUsd, 50, "must correctly decode the hex log data using USDC's real 6 decimals");
  assert.strictEqual(payments[0].txSignature, "0xabc123:0x0", "a tx hash alone isn't unique enough — must include the log index");
  assert.strictEqual(payments[0].taskId, null, "honest limitation: plain ERC-20 Transfer events carry no memo, so taskId cannot be known here");
});

test("extractTaskId: only matches the documented 'task:<id>' pattern, never guesses from unrelated text", () => {
  assert.strictEqual(extractTaskId("task:abc-123"), "abc-123");
  assert.strictEqual(extractTaskId("payment for task:xyz please"), "xyz");
  assert.strictEqual(extractTaskId("just a random note"), null);
  assert.strictEqual(extractTaskId(null), null);
  assert.strictEqual(extractTaskId(""), null);
});

test("REQUIREMENT: an incoming payment is recorded exactly once; a repeated scan of the same rolling window does not double-count it (idempotency)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payment-watch-cycle-"));
  try {
    const economics = new EconomicIntelligence({ persistDir: dir });
    const prevWallet = process.env.PAYMENT_WALLET_SOLANA;
    process.env.PAYMENT_WALLET_SOLANA = WALLET;

    // The SAME transaction is "seen" on both cycles — exactly what
    // happens in production, since every cycle re-scans the last 24h.
    const fetchImpl = jsonRpcResponder({
      getTokenAccountsByOwner: () => ({ value: [{ pubkey: TOKEN_ACCOUNT }] }),
      getSignaturesForAddress: () => [{ signature: "sig-recurring", err: null, blockTime: Math.floor(Date.now() / 1000) - 120 }],
      getTransaction: () => ({
        meta: {
          preTokenBalances: [{ owner: WALLET, mint: TOKENS.solana.usdc.mint, uiTokenAmount: { uiAmount: 0 } }],
          postTokenBalances: [{ owner: WALLET, mint: TOKENS.solana.usdc.mint, uiTokenAmount: { uiAmount: 12.34 } }],
        },
        transaction: { message: { instructions: [] } },
      }),
    });

    try {
      const cycle1 = await runPaymentWatchCycle(economics, { fetchImpl });
      assert.strictEqual(cycle1.recorded, 1);
      assert.strictEqual(cycle1.duplicates, 0);
      assert.strictEqual(economics.summary().totalConfirmedPaymentsUsd, 12.34);

      // Cycle 2, 5 minutes later (per combinedServer.js's real schedule) —
      // re-scans the same window and sees the SAME real transaction again.
      const cycle2 = await runPaymentWatchCycle(economics, { fetchImpl });
      assert.strictEqual(cycle2.recorded, 0, "the same real payment must not be recorded as a SECOND payment");
      assert.strictEqual(cycle2.duplicates, 1);
      assert.strictEqual(
        economics.summary().totalConfirmedPaymentsUsd,
        12.34,
        "the confirmed-payments total must be unchanged after a repeated scan of the same transaction"
      );

      // And a third cycle for good measure — the guarantee must hold indefinitely, not just once.
      const cycle3 = await runPaymentWatchCycle(economics, { fetchImpl });
      assert.strictEqual(cycle3.recorded, 0);
      assert.strictEqual(economics.summary().totalConfirmedPaymentsUsd, 12.34);
    } finally {
      if (prevWallet === undefined) delete process.env.PAYMENT_WALLET_SOLANA;
      else process.env.PAYMENT_WALLET_SOLANA = prevWallet;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPaymentWatchCycle: a failure scanning one network does not stop the other from being scanned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payment-watch-cycle-partial-"));
  const prevSolana = process.env.PAYMENT_WALLET_SOLANA;
  const prevBase = process.env.PAYMENT_WALLET_BASE;
  process.env.PAYMENT_WALLET_SOLANA = WALLET;
  process.env.PAYMENT_WALLET_BASE = "0x000000000000000000000000000000000000ab";

  try {
    const economics = new EconomicIntelligence({ persistDir: dir });
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === "getTokenAccountsByOwner") throw new Error("simulated Solana RPC outage");
      if (body.method === "eth_blockNumber") return { ok: true, json: async () => ({ result: "0x" + (1000).toString(16) }) };
      if (body.method === "eth_getLogs") return { ok: true, json: async () => ({ result: [] }) };
      throw new Error(`unexpected method ${body.method}`);
    };

    const result = await runPaymentWatchCycle(economics, { fetchImpl });
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0].error, /simulated Solana RPC outage/);
    assert.ok(
      result.scanned.some((s) => s.network === "base"),
      "Base must still be scanned even though Solana failed"
    );
  } finally {
    if (prevSolana === undefined) delete process.env.PAYMENT_WALLET_SOLANA;
    else process.env.PAYMENT_WALLET_SOLANA = prevSolana;
    if (prevBase === undefined) delete process.env.PAYMENT_WALLET_BASE;
    else process.env.PAYMENT_WALLET_BASE = prevBase;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
