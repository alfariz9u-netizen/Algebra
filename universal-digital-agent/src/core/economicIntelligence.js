"use strict";

const path = require("node:path");
const { AppendLog, JsonFileStore } = require("./persistence/fileStore");

/**
 * Event types that are "financial": each (type, taskId) pair may be recorded
 * only once. See the IDEMPOTENCY note in the constructor.
 */
const FINANCIAL_EVENT_TYPES = new Set(["task_completed", "task_failed", "payment_received"]);

/** Default upper bound on remembered idempotency keys (override: MAX_FINANCIAL_IDS). */
const DEFAULT_MAX_FINANCIAL_IDS = 10000;

/** First usable value among (explicit option, MAX_FINANCIAL_IDS env var), else the default. */
function resolveMaxFinancialIds(explicit) {
  for (const candidate of [explicit, process.env.MAX_FINANCIAL_IDS]) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return DEFAULT_MAX_FINANCIAL_IDS;
}

/** USD amounts are summed as floats; round to 1e-6 so e.g. 0.1 + 0.2 doesn't leak 0.30000000000000004 into the new fields. */
const roundUsd = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The money contribution of ONE event. Single source of truth shared by the
 * live mirror (_addToLive/_removeFromLive) and the prune() rollup fold, so
 * the two can never drift apart.
 *
 *   revenue  - legacy "totalRevenueUsd" bucket: `revenueUsd` carried on a
 *              task_completed event PLUS payments received.
 *   expected - the reward the platform ADVERTISED (task_completed.expectedRevenueUsd).
 *              A promise, not money.
 *   payments - money actually RECEIVED (payment_received.amountUsd), i.e.
 *              what a Solana explorer would show.
 *   cost     - model/LLM cost.
 */
function financialDelta(e) {
  if (e.type === "task_completed") {
    return { revenue: e.revenueUsd || 0, expected: e.expectedRevenueUsd || 0, payments: 0, cost: e.costUsd || 0 };
  }
  if (e.type === "payment_received") {
    const amount = e.amountUsd || 0;
    return { revenue: amount, expected: 0, payments: amount, cost: 0 };
  }
  return null;
}

/** Idempotency key for a financial event, or null for events that aren't deduplicated. */
function financialKey(e) {
  return FINANCIAL_EVENT_TYPES.has(e.type) && e.taskId ? `${e.type}:${e.taskId}` : null;
}

/**
 * Economic Intelligence (spec section 13). Tracks outcomes and aggregates
 * them into decision-relevant statistics — deterministic bookkeeping and
 * arithmetic, not a black-box "learning" claim.
 *
 * EXPECTED vs. ACTUAL REVENUE: completing a task is NOT the same as being
 * paid. `task_completed` carries the advertised reward in
 * `expectedRevenueUsd` (a promise) and `revenueUsd: 0`; money only counts
 * as revenue when `recordPayment()` logs a `payment_received` event (with
 * the on-chain tx signature in `metadata.txSignature`). `summary()` keeps
 * the two apart:
 *   totalExpectedRevenueUsd - sum of advertised rewards
 *   totalActualRevenueUsd   - sum of payments actually received
 *   pendingPaymentsUsd      - expected minus actual (never negative)
 * `totalRevenueUsd`/`totalProfitUsd` are kept for backward compatibility
 * (= revenue carried on events + payments received, minus cost).
 *
 * PERSISTENCE: in-memory by default. Pass `{ persistDir }` so revenue/cost
 * history and platform/model performance stats survive restarts.
 *
 * AGGREGATION: `summary()` is called from `dashboard()`, which can be
 * polled frequently. It used to rescan the entire in-memory `events` array
 * on every call (O(n) per call, worse the longer the process runs before
 * `prune()` gets a chance to run). Counts and revenue/cost totals are now
 * maintained incrementally in `_live` as events are recorded, so
 * `summary()` is O(1). `bestPlatform()`/`bestModel()` still scan `events`
 * because they need per-platform/per-model breakdowns that aren't worth
 * maintaining incrementally for every possible key — but they only run
 * against currently-retained (unpruned) detail, same as before.
 *
 * PRUNING: `events` would otherwise grow forever. `prune()` physically
 * removes old/excess events from memory and disk — but naively deleting
 * financial events would silently understate lifetime revenue/cost, so
 * pruned events are first folded into a persisted rollup counter
 * (`economic-rollup.json`) that `summary()` always includes. Nothing is
 * lost, only the per-event detail is discarded. Expected revenue and
 * received payments are folded into the rollup the same way.
 */
class EconomicIntelligence {
  constructor({ persistDir, encryptionKey, maxFinancialIds } = {}) {
    this._log = persistDir ? new AppendLog(path.join(persistDir, "economic-events.jsonl"), { encryptionKey }) : null;
    this._rollupStore = persistDir ? new JsonFileStore(path.join(persistDir, "economic-rollup.json"), { encryptionKey }) : null;
    this.events = this._log ? this._log.loadAll() : [];

    // Rollup files written before expected/actual tracking existed lack the
    // two new counters — default them to 0 instead of producing NaN.
    const rollupDefaults = {
      countsByType: {},
      totalRevenueUsd: 0,
      totalCostUsd: 0,
      totalExpectedRevenueUsd: 0,
      totalPaymentsUsd: 0,
    };
    this.rollup = {
      ...rollupDefaults,
      ...(this._rollupStore ? this._rollupStore.load(rollupDefaults) : {}),
    };

    // Incremental mirror of whatever is currently in `this.events`, kept in
    // sync by record()/prune() so summary() never has to rescan events.
    this._live = { countsByType: {}, totalRevenueUsd: 0, totalCostUsd: 0, totalExpectedRevenueUsd: 0, totalPaymentsUsd: 0 };
    for (const e of this.events) this._addToLive(e);

    // IDEMPOTENCY (requested explicitly: "تأكد من تسجيل task_completed...
    // مرة واحدة فقط"): a financial event (task_completed / task_failed /
    // payment_received) for the same taskId must only ever be counted once,
    // no matter how many times record() is called for it — a retried
    // delivery after a crash, a duplicate webhook, or a double call from a
    // bug should never double revenue/cost. Rebuilt from history on
    // construction so this holds across restarts, not just within one
    // process's memory.
    //
    // BOUNDED MEMORY: this used to be an ever-growing Set. On a long-running
    // process (weeks, Render's 512MB free plan) that is a slow leak that ends
    // in an OOM kill. It is now a Map (key -> event timestamp) whose
    // insertion order doubles as age order, and it is capped at
    // `maxFinancialIds` (default 10,000, env MAX_FINANCIAL_IDS): when full,
    // the OLDEST key is evicted. Two consequences, both deliberate:
    //   - prune() keeps the Map equal to the keys of the events that are
    //     still retained (see prune()).
    //   - duplicate protection covers the most recent `maxFinancialIds`
    //     financial events (and never more than what is still retained); a
    //     replay of an event older than that window is no longer recognised.
    // The Map itself is not written to disk: it is derived from the event
    // log, which prune() rewrites, so a restart rebuilds exactly this state.
    this._maxFinancialIds = resolveMaxFinancialIds(maxFinancialIds);
    this._recordedFinancialTaskIds = new Map();
    for (const e of this.events) {
      const key = financialKey(e);
      if (key) this._rememberFinancialKey(key, e.timestamp);
    }
  }

  /** Adds a key, evicting the oldest ones so the Map never exceeds the cap. */
  _rememberFinancialKey(key, timestamp) {
    const ids = this._recordedFinancialTaskIds;
    ids.set(key, timestamp);
    while (ids.size > this._maxFinancialIds) {
      ids.delete(ids.keys().next().value); // Map iterates in insertion order => first key is the oldest
    }
  }

  _addToLive(e) {
    this._live.countsByType[e.type] = (this._live.countsByType[e.type] || 0) + 1;
    const d = financialDelta(e);
    if (d) {
      this._live.totalRevenueUsd += d.revenue;
      this._live.totalCostUsd += d.cost;
      this._live.totalExpectedRevenueUsd += d.expected;
      this._live.totalPaymentsUsd += d.payments;
    }
  }

  _removeFromLive(e) {
    this._live.countsByType[e.type] = (this._live.countsByType[e.type] || 0) - 1;
    const d = financialDelta(e);
    if (d) {
      this._live.totalRevenueUsd -= d.revenue;
      this._live.totalCostUsd -= d.cost;
      this._live.totalExpectedRevenueUsd -= d.expected;
      this._live.totalPaymentsUsd -= d.payments;
    }
  }

  /**
   * Returns the recorded entry, or `{ duplicate: true, ... }` without
   * writing anything if this exact financial outcome (type + taskId) was
   * already recorded — the caller should treat both the same way (the
   * work is "recorded"); only the caller needs to know whether a NEW
   * write happened if it cares about side effects like logging.
   * `taskId` is required for "task_completed"/"task_failed"/"payment_received"
   * specifically — other event types (task_discovered, bid_won, moltbook
   * posts, etc.) aren't double-counting-sensitive in the same way and
   * aren't deduped.
   */
  record(event) {
    const dedupeKey = financialKey(event);
    if (dedupeKey && this._recordedFinancialTaskIds.has(dedupeKey)) {
      return { duplicate: true, type: event.type, taskId: event.taskId };
    }
    const entry = { timestamp: Date.now(), ...event };
    if (dedupeKey) this._rememberFinancialKey(dedupeKey, entry.timestamp);
    this.events.push(entry);
    this._addToLive(entry);
    if (this._log) this._log.append(entry);
    return entry;
  }

  /**
   * Records a payment that was actually RECEIVED (as opposed to merely
   * advertised by a platform) — the only thing that increases
   * `totalActualRevenueUsd`.
   *
   * Idempotent per `taskId`: a second call for the same task writes nothing
   * and returns `{ duplicate: true, ... }`, using the same mechanism as
   * task_completed/task_failed.
   *
   * `txSignature` (the Solana transaction signature) is stored in
   * `metadata.txSignature` so the payment can be verified on Solscan.
   *
   * @param {{ taskId: string, amountUsd: number, txSignature?: string, connector?: string }} payment
   * @returns the recorded entry, or `{ duplicate: true, type, taskId }`
   * @throws {TypeError} when taskId is missing or amountUsd isn't a positive finite number
   */
  recordPayment({ taskId, amountUsd, txSignature, connector } = {}) {
    if (taskId === undefined || taskId === null || taskId === "") {
      throw new TypeError("recordPayment: taskId is required (it is the idempotency key)");
    }
    if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new TypeError("recordPayment: amountUsd must be a positive finite number");
    }
    return this.record({
      type: "payment_received",
      taskId,
      amountUsd,
      connector,
      metadata: { txSignature: txSignature || null },
    });
  }

  /** e.g. { type: "task_discovered" | "task_accepted" | "task_rejected" | "bid_won" | "bid_lost" | "task_completed" | "task_failed" | "payment_received", ... } */

  summary() {
    const byType = { ...this.rollup.countsByType };
    for (const [type, count] of Object.entries(this._live.countsByType)) {
      byType[type] = (byType[type] || 0) + count;
    }

    const revenue = this.rollup.totalRevenueUsd + this._live.totalRevenueUsd;
    const cost = this.rollup.totalCostUsd + this._live.totalCostUsd;
    const expected = this.rollup.totalExpectedRevenueUsd + this._live.totalExpectedRevenueUsd;
    const actual = this.rollup.totalPaymentsUsd + this._live.totalPaymentsUsd;

    return {
      countsByType: byType,
      // Backward-compatible totals: revenue carried on events + payments received.
      totalRevenueUsd: revenue,
      totalCostUsd: cost,
      totalProfitUsd: revenue - cost,
      // Expected (advertised) vs. actual (received) revenue.
      totalExpectedRevenueUsd: roundUsd(expected),
      totalActualRevenueUsd: roundUsd(actual),
      // Clamped at 0: a payment for a task that was never recorded as completed must not show "negative pending".
      pendingPaymentsUsd: roundUsd(Math.max(0, expected - actual)),
    };
  }

  /** Which connector/platform has the best average profit (based on currently-retained detail only — rolled-up events lose per-platform breakdown by design, since only the totals are preserved). */
  bestPlatform() {
    const byPlatform = {};
    for (const e of this.events) {
      if (e.type !== "task_completed" || !e.connector) continue;
      byPlatform[e.connector] = byPlatform[e.connector] || { profit: 0, count: 0 };
      byPlatform[e.connector].profit += (e.revenueUsd || 0) - (e.costUsd || 0);
      byPlatform[e.connector].count += 1;
    }
    let best = null;
    for (const [connector, stats] of Object.entries(byPlatform)) {
      const avg = stats.profit / stats.count;
      if (!best || avg > best.avgProfit) best = { connector, avgProfit: avg, count: stats.count };
    }
    return best;
  }

  /** Which model produced the highest QA pass rate. */
  bestModel() {
    const byModel = {};
    for (const e of this.events) {
      if (e.type !== "task_completed" && e.type !== "task_failed") continue;
      if (!e.model) continue;
      byModel[e.model] = byModel[e.model] || { passed: 0, total: 0 };
      byModel[e.model].total += 1;
      if (e.type === "task_completed") byModel[e.model].passed += 1;
    }
    let best = null;
    for (const [model, stats] of Object.entries(byModel)) {
      const rate = stats.passed / stats.total;
      if (!best || rate > best.successRate) best = { model, successRate: rate, count: stats.total };
    }
    return best;
  }

  /**
   * Physically removes old/excess events, but first folds their financial
   * contribution into `this.rollup` so `summary()`'s totals never silently
   * shrink (revenue, cost, expected revenue and received payments alike).
   * This is the honest way to bound storage growth without lying about
   * historical revenue/cost.
   *
   * It also resyncs the idempotency Map with what is left: afterwards it
   * holds only keys of events still present in `this.events` (newest
   * `maxFinancialIds` at most) — exactly the state a fresh process would
   * rebuild from the rewritten log. Keys of removed events are dropped, so
   * the Map can't outgrow the retained history.
   *
   * @returns {{ before: number, after: number, removed: number }}
   */
  prune({ maxAgeMs, maxEntries } = {}) {
    const before = this.events.length;
    let toRemove = [];
    let kept = this.events;

    if (maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      toRemove = kept.filter((e) => e.timestamp < cutoff);
      kept = kept.filter((e) => e.timestamp >= cutoff);
    }
    if (maxEntries && kept.length > maxEntries) {
      const excess = kept.slice(0, kept.length - maxEntries);
      toRemove = toRemove.concat(excess);
      kept = kept.slice(-maxEntries);
    }

    for (const e of toRemove) {
      this.rollup.countsByType[e.type] = (this.rollup.countsByType[e.type] || 0) + 1;
      const d = financialDelta(e);
      if (d) {
        this.rollup.totalRevenueUsd += d.revenue;
        this.rollup.totalCostUsd += d.cost;
        this.rollup.totalExpectedRevenueUsd += d.expected;
        this.rollup.totalPaymentsUsd += d.payments;
      }
      this._removeFromLive(e);
    }

    this.events = kept;

    // Rebuild (rather than delete one key per removed event): a key can have
    // been evicted by the cap and re-recorded later, so "delete the removed
    // event's key" could wrongly drop protection for a retained twin.
    if (toRemove.length > 0) {
      this._recordedFinancialTaskIds = new Map();
      for (const e of this.events) {
        const key = financialKey(e);
        if (key) this._rememberFinancialKey(key, e.timestamp);
      }
    }

    if (this._log) this._log.rewrite(this.events);
    if (this._rollupStore) this._rollupStore.save(this.rollup);

    return { before, after: this.events.length, removed: before - this.events.length };
  }
}

module.exports = EconomicIntelligence;
