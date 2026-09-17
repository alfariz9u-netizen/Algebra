"use strict";

/**
 * Real, live SOL/USD price oracle for pricing AgenC opportunities in USD.
 * Uses CoinGecko's public simple-price endpoint — no API key required.
 * https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd
 *
 * Priority order:
 *   1. AGENC_SOL_USD_PRICE env var — an explicit operator override always
 *      wins (useful for offline testing, or distrust of the live feed).
 *   2. A recent cached fetch (avoids hammering CoinGecko on every single
 *      opportunity evaluated in a discovery cycle).
 *   3. A real live fetch.
 *   4. If the live fetch fails and no cache exists, throws rather than
 *      fabricating a number — callers (see strategies/agenc.js) catch this
 *      and fall back to `rewardUsd: null`, the same honest default as
 *      before this oracle existed.
 */

const DEFAULT_TTL_MS = Number(process.env.PRICE_ORACLE_TTL_MS || 5 * 60 * 1000);

let cache = { price: null, fetchedAt: 0 };

async function defaultFetcher() {
  const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
  if (!response.ok) throw new Error(`CoinGecko request failed: ${response.status}`);
  const data = await response.json();
  const price = data?.solana?.usd;
  if (typeof price !== "number") throw new Error("Unexpected CoinGecko response shape (no solana.usd field).");
  return price;
}

/**
 * @param {{ ttlMs?: number, fetcher?: () => Promise<number> }} [options]
 *   `fetcher` is injectable for tests — don't hit the real network from a test suite.
 */
async function getSolUsdPrice({ ttlMs = DEFAULT_TTL_MS, fetcher } = {}) {
  if (process.env.AGENC_SOL_USD_PRICE) {
    return { price: Number(process.env.AGENC_SOL_USD_PRICE), source: "manual-override" };
  }

  if (cache.price !== null && Date.now() - cache.fetchedAt < ttlMs) {
    return { price: cache.price, source: "cache" };
  }

  const doFetch = fetcher || defaultFetcher;
  try {
    const price = await doFetch();
    cache = { price, fetchedAt: Date.now() };
    return { price, source: "live" };
  } catch (err) {
    if (cache.price !== null) {
      return { price: cache.price, source: "stale-cache", staleReason: err.message };
    }
    throw new Error(`Could not determine SOL/USD price: ${err.message}. Set AGENC_SOL_USD_PRICE to override.`);
  }
}

/** Test-only: clears the module-level cache so tests don't leak state into each other. */
function _resetCacheForTests() {
  cache = { price: null, fetchedAt: 0 };
}

module.exports = { getSolUsdPrice, _resetCacheForTests };
