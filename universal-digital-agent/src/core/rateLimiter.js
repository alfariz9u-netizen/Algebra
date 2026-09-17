"use strict";

/**
 * Token-bucket rate limiter (supports spec sections 24/31: loop prevention,
 * abuse resistance). Pure arithmetic, no LLM involved. Applied per
 * connector name (or any string key) so a compromised/malicious task can't
 * hammer a single external service into rate-limit bans or run up costs.
 */
class RateLimiter {
  /**
   * `now` defaults to `Date.now` but can be overridden with a controllable
   * clock function — this lets tests exercise refill behavior exactly
   * (e.g. "advance 500ms") instead of sleeping in real time and asserting
   * with a tolerance, which is inherently flaky under CI load.
   */
  constructor({ capacity = 10, refillPerSecond = 1, now = Date.now } = {}) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this._now = now;
    this.buckets = new Map(); // key -> { tokens, lastRefill }
  }

  _bucket(key) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: this._now() };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  _refill(bucket) {
    const now = this._now();
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    const refillAmount = elapsedSeconds * this.refillPerSecond;
    if (refillAmount > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refillAmount);
      bucket.lastRefill = now;
    }
  }

  /** Returns true and consumes a token if allowed; false (no consumption) if the bucket is empty. */
  tryConsume(key, cost = 1) {
    const bucket = this._bucket(key);
    this._refill(bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Throws instead of returning false, for call sites that want fail-fast behavior. */
  assertConsume(key, cost = 1) {
    if (!this.tryConsume(key, cost)) {
      throw new Error(`Rate limit exceeded for "${key}". Refusing to proceed to prevent abuse/runaway loops.`);
    }
  }

  remaining(key) {
    const bucket = this._bucket(key);
    this._refill(bucket);
    return bucket.tokens;
  }
}

module.exports = RateLimiter;
