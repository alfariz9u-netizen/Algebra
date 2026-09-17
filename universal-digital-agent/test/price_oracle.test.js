"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

async function main() {
  delete process.env.AGENC_SOL_USD_PRICE;
  delete require.cache[require.resolve("../src/core/priceOracle")];
  const { getSolUsdPrice, _resetCacheForTests } = require("../src/core/priceOracle");
  _resetCacheForTests();

  // --- Manual override always wins ---
  process.env.AGENC_SOL_USD_PRICE = "123.45";
  const overridden = await getSolUsdPrice();
  assert.strictEqual(overridden.price, 123.45);
  assert.strictEqual(overridden.source, "manual-override");
  console.log("PASS: an explicit AGENC_SOL_USD_PRICE override always wins, no fetch attempted");
  delete process.env.AGENC_SOL_USD_PRICE;

  // --- Real live fetch (injected fetcher — no actual network call in this test) ---
  _resetCacheForTests();
  let fetchCount = 0;
  const fakeLiveFetcher = async () => {
    fetchCount++;
    return 180.5;
  };
  const live = await getSolUsdPrice({ fetcher: fakeLiveFetcher, ttlMs: 60000 });
  assert.strictEqual(live.price, 180.5);
  assert.strictEqual(live.source, "live");
  assert.strictEqual(fetchCount, 1);
  console.log("PASS: a live fetch is made and its price returned when no cache/override exists");

  // --- Caching: a second call within the TTL should NOT re-fetch ---
  const cached = await getSolUsdPrice({ fetcher: fakeLiveFetcher, ttlMs: 60000 });
  assert.strictEqual(cached.price, 180.5);
  assert.strictEqual(cached.source, "cache");
  assert.strictEqual(fetchCount, 1, "the fetcher must not be called again while the cache is still fresh");
  console.log("PASS: a recent price is served from cache instead of re-fetching every call");

  // --- Failure with a stale cache available: serve the stale price rather than throwing ---
  const failingFetcher = async () => {
    throw new Error("network down");
  };
  const stale = await getSolUsdPrice({ fetcher: failingFetcher, ttlMs: 0 }); // ttlMs=0 forces "not fresh", triggering a fetch attempt
  assert.strictEqual(stale.price, 180.5);
  assert.strictEqual(stale.source, "stale-cache");
  assert.ok(stale.staleReason.includes("network down"));
  console.log("PASS: if a live re-fetch fails, a previously known price is served as stale-cache rather than failing outright");

  // --- Failure with NO cache at all: must throw honestly, never fabricate a number ---
  _resetCacheForTests();
  await assert.rejects(() => getSolUsdPrice({ fetcher: failingFetcher, ttlMs: 60000 }), /Could not determine SOL\/USD price/);
  console.log("PASS: with no cache and a failing fetch, the oracle throws honestly instead of inventing a price");
}

test("Price oracle tests", async () => {
  await main();
});
