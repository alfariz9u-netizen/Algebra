"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const RateLimiter = require("../src/core/rateLimiter");

test("Rate limiter tests", async (t) => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 10 });

  await t.test("bucket allows up to its capacity", async () => {
      assert.strictEqual(limiter.tryConsume("connX"), true);
      assert.strictEqual(limiter.tryConsume("connX"), true);
      assert.strictEqual(limiter.tryConsume("connX"), true);
  });

  await t.test("exceeding capacity is blocked", async () => {
    assert.strictEqual(limiter.tryConsume("connX"), false, "4th immediate call should be blocked");
  });

  await t.test("assertConsume throws a clear error when exhausted", async () => {
    assert.throws(() => limiter.assertConsume("connX"), /Rate limit exceeded/);
  });

  await t.test("buckets are isolated per key — one connector's abuse doesn't block another", async () => {
    // A different key has its own independent bucket.
      assert.strictEqual(limiter.tryConsume("connY"), true);
  });

  await t.test("bucket refills over time", async () => {
    await new Promise((r) => setTimeout(r, 150)); // 150ms * 10/sec refill ~= 1.5 tokens
      assert.strictEqual(limiter.tryConsume("connX"), true, "bucket should have refilled at least one token");
  });

});
