"use strict";

const path = require("node:path");
const { AppendLog, JsonFileStore } = require("./persistence/fileStore");

/**
 * Economic Intelligence (spec section 13). Tracks outcomes and aggregates
 * them into decision-relevant statistics — deterministic bookkeeping and
 * arithmetic, not a black-box "learning" claim.
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
 * lost, only the per-event detail is discarded.
 */
class EconomicIntelligence {
  constructor({ persistDir, encryptionKey } = {}) {
    this._log = persistDir ? new AppendLog(path.join(persistDir, "economic-events.jsonl"), { encryptionKey }) : null;
    this._rollupStore = persistDir ? new JsonFileStore(path.join(persistDir, "economic-rollup.json"), { encryptionKey }) : null;
    this.events = this._log ? this._log.loadAll() : [];
    this.rollup = this._rollupStore
      ? this._rollupStore.load({ countsByType: {}, totalRevenueUsd: 0, totalCostUsd: 0 })
      : { countsByType: {}, totalRevenueUsd: 0, totalCostUsd: 0 };

    // Incremental mirror of whatever is currently in `this.events`, kept in
    // sync by record()/prune() so summary() never has to rescan events.
    this._live = { countsByType: {}, totalRevenueUsd: 0, totalCostUsd: 0 };
    for (const e of this.events) this._addToLive(e);
  }

  _addToLive(e) {
    this._live.countsByType[e.type] = (this._live.countsByType[e.type] || 0) + 1;
    if (e.type === "task_completed") {
      this._live.totalRevenueUsd += e.revenueUsd || 0;
      this._live.totalCostUsd += e.costUsd || 0;
    }
  }

  _removeFromLive(e) {
    this._live.countsByType[e.type] = (this._live.countsByType[e.type] || 0) - 1;
    if (e.type === "task_completed") {
      this._live.totalRevenueUsd -= e.revenueUsd || 0;
      this._live.totalCostUsd -= e.costUsd || 0;
    }
  }

  record(event) {
    const entry = { timestamp: Date.now(), ...event };
    this.events.push(entry);
    this._addToLive(entry);
    if (this._log) this._log.append(entry);
  }

  /** e.g. { type: "task_discovered" | "task_accepted" | "task_rejected" | "bid_won" | "bid_lost" | "task_completed" | "task_failed", ... } */

  summary() {
    const byType = { ...this.rollup.countsByType };
    for (const [type, count] of Object.entries(this._live.countsByType)) {
      byType[type] = (byType[type] || 0) + count;
    }

    const revenue = this.rollup.totalRevenueUsd + this._live.totalRevenueUsd;
    const cost = this.rollup.totalCostUsd + this._live.totalCostUsd;

    return {
      countsByType: byType,
      totalRevenueUsd: revenue,
      totalCostUsd: cost,
      totalProfitUsd: revenue - cost,
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
   * shrink. This is the honest way to bound storage growth without lying
   * about historical revenue/cost.
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
      if (e.type === "task_completed") {
        this.rollup.totalRevenueUsd += e.revenueUsd || 0;
        this.rollup.totalCostUsd += e.costUsd || 0;
      }
      this._removeFromLive(e);
    }

    this.events = kept;
    if (this._log) this._log.rewrite(this.events);
    if (this._rollupStore) this._rollupStore.save(this.rollup);

    return { before, after: this.events.length, removed: before - this.events.length };
  }
}

module.exports = EconomicIntelligence;
