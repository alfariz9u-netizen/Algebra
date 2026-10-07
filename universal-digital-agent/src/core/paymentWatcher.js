"use strict";

/**
 * Scans a wallet for real incoming stablecoin payments on Solana or Base,
 * and records confirmed ones via economics.recordPayment() — see the long
 * comment on recordPayment() in economicIntelligence.js for why this is
 * the ONLY thing that should count as real revenue in this project, as
 * opposed to task_completed's unconfirmed `expectedRevenueUsd`.
 *
 * TOKEN ADDRESSES — verified directly against Circle's own official
 * documentation (developers.circle.com/stablecoins/usdc-contract-addresses)
 * and Tether's own supported-protocols page (tether.to/supported-protocols),
 * not guessed:
 *   USDC (Solana mainnet mint):  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *   USDC (Base mainnet, native): 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   USDT (Solana mainnet mint):  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
 *   USDT (Base): Tether's own supported-protocols page does NOT list Base
 *     as an officially Tether-issued chain (unlike Solana, Ethereum,
 *     Tron, etc.) — what circulates as "USDT" on Base is a BRIDGED token,
 *     not something Tether mints directly. Included below for
 *     completeness, sourced from Basescan, but flagged explicitly as
 *     lower-confidence than the three above — verify independently
 *     before relying on it for real accounting.
 *
 * SOLANA APPROACH: rather than deriving the wallet's Associated Token
 * Account address ourselves (a real cryptographic PDA derivation that is
 * genuinely easy to get subtly wrong without the official SDK — the same
 * reasoning that kept this project from hand-rolling Agentverse identity
 * derivation), this uses the standard `getTokenAccountsByOwner` RPC
 * method, which asks the RPC node to resolve it for us. This is a
 * well-established, widely-documented Solana JSON-RPC method, not a
 * guess.
 *
 * BASE APPROACH: standard `eth_getLogs` for ERC-20 Transfer events
 * (topic0 = keccak256("Transfer(address,address,uint256)") =
 * 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef —
 * one of the most universally fixed, documented constants in Ethereum
 * tooling), filtered to transfers where `to` is our wallet.
 *
 * MEMO / taskId MATCHING — a real, honest asymmetry between the two
 * chains: Solana has a standard Memo program, so a payer can attach a
 * memo instruction to the same transaction and we can read it back.
 * Standard ERC-20 Transfer events on Base/EVM chains carry NO memo field
 * at all — there is no on-chain way to attach a note to a plain token
 * transfer. So on Base, `taskId` comes back null unless the caller later
 * matches it some other way (amount + timing, a separate payment-intent
 * record, etc.) — this file does not invent a mechanism that doesn't
 * exist on-chain.
 */

const TOKENS = {
  solana: {
    usdc: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    usdt: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  },
  base: {
    usdc: { contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    // Lower confidence — see the file-level comment above.
    usdt: { contract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
  },
};

const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_AVERAGE_BLOCK_SECONDS = 2; // Base's published target block time

function asPositiveInt(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** SPL Memo program id — fixed, well-known constant, used to recognize a memo instruction in a parsed Solana transaction. */
const SPL_MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

async function solanaRpc(rpcUrl, method, params, fetchImpl) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Solana RPC ${method} failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(`Solana RPC ${method} error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

async function scanSolana({ rpcUrl, walletAddress, lookbackHours, tokens, fetchImpl }) {
  const cutoffUnixSeconds = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const payments = [];

  for (const tokenName of tokens) {
    const tokenInfo = TOKENS.solana[tokenName];
    if (!tokenInfo) continue;

    const accountsResult = await solanaRpc(
      rpcUrl,
      "getTokenAccountsByOwner",
      [walletAddress, { mint: tokenInfo.mint }, { encoding: "jsonParsed" }],
      fetchImpl
    );
    const tokenAccounts = (accountsResult?.value || []).map((v) => v.pubkey);

    for (const tokenAccountAddress of tokenAccounts) {
      const signatures = await solanaRpc(rpcUrl, "getSignaturesForAddress", [tokenAccountAddress, { limit: 1000 }], fetchImpl);

      for (const sigInfo of signatures || []) {
        if (sigInfo.err) continue; // failed transaction — nothing real moved
        if (typeof sigInfo.blockTime === "number" && sigInfo.blockTime < cutoffUnixSeconds) continue; // outside the lookback window

        const tx = await solanaRpc(
          rpcUrl,
          "getTransaction",
          [sigInfo.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
          fetchImpl
        );
        if (!tx || !tx.meta) continue;

        // Compute this token account's balance delta across the transaction.
        const pre = (tx.meta.preTokenBalances || []).find((b) => b.owner === walletAddress && b.mint === tokenInfo.mint);
        const post = (tx.meta.postTokenBalances || []).find((b) => b.owner === walletAddress && b.mint === tokenInfo.mint);
        const preAmount = Number(pre?.uiTokenAmount?.uiAmount || 0);
        const postAmount = Number(post?.uiTokenAmount?.uiAmount || 0);
        const delta = postAmount - preAmount;
        if (!(delta > 0)) continue; // not an incoming transfer (outgoing, or not involving us)

        // Look for an attached SPL Memo instruction in the same transaction.
        let memo = null;
        const instructions = tx.transaction?.message?.instructions || [];
        for (const ix of instructions) {
          if (ix.programId === SPL_MEMO_PROGRAM_ID || ix.program === "spl-memo") {
            memo = ix.parsed || ix.data || null;
            break;
          }
        }

        const from =
          (tx.meta.preTokenBalances || []).find((b) => b.mint === tokenInfo.mint && b.owner !== walletAddress)?.owner || null;

        payments.push({
          txSignature: sigInfo.signature,
          amountUsd: delta, // 1 USDC/USDT ≈ $1 by design of the stablecoin itself
          token: tokenName.toUpperCase(),
          network: "solana",
          from,
          memo,
          taskId: extractTaskId(memo),
          blockTime: sigInfo.blockTime || null,
        });
      }
    }
  }

  return payments;
}

async function evmRpc(rpcUrl, method, params, fetchImpl) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Base RPC ${method} failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(`Base RPC ${method} error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

function padAddressToTopic(address) {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function scanBase({ rpcUrl, walletAddress, lookbackHours, tokens, fetchImpl }) {
  const latestHex = await evmRpc(rpcUrl, "eth_blockNumber", [], fetchImpl);
  const latestBlock = parseInt(latestHex, 16);
  const blocksBack = Math.ceil((lookbackHours * 3600) / BASE_AVERAGE_BLOCK_SECONDS);
  const fromBlock = Math.max(0, latestBlock - blocksBack);
  const payments = [];

  for (const tokenName of tokens) {
    const tokenInfo = TOKENS.base[tokenName];
    if (!tokenInfo) continue;

    const logs = await evmRpc(
      rpcUrl,
      "eth_getLogs",
      [
        {
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "latest",
          address: tokenInfo.contract,
          topics: [TRANSFER_EVENT_TOPIC, null, padAddressToTopic(walletAddress)],
        },
      ],
      fetchImpl
    );

    for (const log of logs || []) {
      const rawAmount = BigInt(log.data);
      const amountUsd = Number(rawAmount) / 10 ** tokenInfo.decimals;
      if (!(amountUsd > 0)) continue;
      const fromTopic = log.topics[1];
      const from = fromTopic ? "0x" + fromTopic.slice(-40) : null;

      payments.push({
        // A log doesn't have one "signature" the way Solana does — the
        // transaction hash + log index together uniquely identify this
        // specific transfer event (a single tx can contain more than one).
        txSignature: `${log.transactionHash}:${log.logIndex}`,
        amountUsd,
        token: tokenName.toUpperCase(),
        network: "base",
        from,
        memo: null, // honest limitation — see the file-level comment above
        taskId: null,
        blockTime: null, // would need an extra eth_getBlockByNumber call per log to resolve; not fetched here to keep this cheap
      });
    }
  }

  return payments;
}

/** Looks for a `task:<id>` pattern in a memo string; returns null if none found. Deliberately conservative — a false match would mis-attribute real money to the wrong task. */
function extractTaskId(memo) {
  if (!memo || typeof memo !== "string") return null;
  const match = /task:([a-zA-Z0-9_-]+)/.exec(memo);
  return match ? match[1] : null;
}

/**
 * @param {{ network: "solana"|"base", walletAddress: string, lookbackHours?: number, tokens?: string[], fetchImpl?: Function }} opts
 * @returns {Promise<Array<{txSignature, amountUsd, token, network, from, memo, taskId, blockTime}>>}
 */
async function scanWalletForPayments({ network, walletAddress, lookbackHours = 24, tokens = ["usdc"], fetchImpl = fetch } = {}) {
  if (!walletAddress) throw new Error("scanWalletForPayments: walletAddress is required.");
  const hours = asPositiveInt(lookbackHours, 24);

  if (network === "solana") {
    const rpcUrl = process.env.PAYMENT_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    return scanSolana({ rpcUrl, walletAddress, lookbackHours: hours, tokens, fetchImpl });
  }
  if (network === "base") {
    const rpcUrl = process.env.PAYMENT_BASE_RPC_URL || "https://mainnet.base.org";
    return scanBase({ rpcUrl, walletAddress, lookbackHours: hours, tokens, fetchImpl });
  }
  throw new Error(`scanWalletForPayments: unsupported network "${network}" (expected "solana" or "base").`);
}

/**
 * Runs one full watch cycle: scans whichever networks have a configured
 * wallet address (PAYMENT_WALLET_SOLANA / PAYMENT_WALLET_BASE) and
 * records every detected payment via economics.recordPayment() —
 * idempotent by txSignature, so calling this repeatedly on a rolling
 * window (as combinedServer.js does, every 5 minutes) never double-counts
 * a real payment it already saw.
 */
async function runPaymentWatchCycle(economics, { fetchImpl = fetch, lookbackHours } = {}) {
  const results = { scanned: [], recorded: 0, duplicates: 0, errors: [] };
  const configs = [
    { network: "solana", walletAddress: process.env.PAYMENT_WALLET_SOLANA },
    { network: "base", walletAddress: process.env.PAYMENT_WALLET_BASE },
  ].filter((c) => c.walletAddress);

  for (const { network, walletAddress } of configs) {
    try {
      const payments = await scanWalletForPayments({ network, walletAddress, lookbackHours, fetchImpl });
      for (const p of payments) {
        const outcome = economics.recordPayment({
          taskId: p.taskId,
          amountUsd: p.amountUsd,
          txSignature: p.txSignature,
          network: p.network,
          token: p.token,
          from: p.from,
        });
        if (outcome.duplicate) results.duplicates += 1;
        else results.recorded += 1;
      }
      results.scanned.push({ network, walletAddress, found: payments.length });
    } catch (err) {
      results.errors.push({ network, walletAddress, error: err.message });
    }
  }
  return results;
}

module.exports = { scanWalletForPayments, runPaymentWatchCycle, TOKENS, extractTaskId };
