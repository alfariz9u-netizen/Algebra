"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { AppendLog, JsonFileStore } = require("./persistence/fileStore");
const { SupabaseState, WriteBehindQueue } = require("./persistence/supabaseState");

// ---- Supabase mapping (see supabase/migrations/001_state_tables.sql) --------
// Event fields that have their own column; everything else goes to `metadata`.
const COLUMN_BY_FIELD = {
  taskId: "task_id",
  connector: "connector",
  model: "model",
  revenueUsd: "revenue_usd",
  costUsd: "cost_usd",
  expectedRevenueUsd: "expected_revenue_usd",
  amountUsd: "amount_usd",
};
const FIELD_BY_COLUMN = Object.fromEntries(Object.entries(COLUMN_BY_FIELD).map(([f, c]) => [c, f]));
const NUMERIC_FIELDS = new Set(["revenueUsd", "costUsd", "expectedRevenueUsd", "amountUsd"]);
const FINANCIAL_TYPES = new Set(["task_completed", "task_failed", "payment_received"]);
const r6 = (n) => Math.round(n * 1e6) / 1e6; // no float noise (0.1 + 0.2) in reported totals

function eventToRow(e) {
  const row = { id: e.id, timestamp: e.timestamp, type: e.type, metadata: {} };
  for (const [k, v] of Object.entries(e)) {
    if (k === "id" || k === "timestamp" || k === "type") continue;
    if (k === "metadata" && v && typeof v === "object") Object.assign(row.metadata, v); // payment details (txSignature, network, token, from)
    else if (COLUMN_BY_FIELD[k]) row[COLUMN_BY_FIELD[k]] = v === undefined ? null : v;
    else if (v !== undefined) row.metadata[k] = v;
  }
  // The on-chain signature stays in event.metadata.txSignature, and is mirrored
  // to its own (unique) column so one real transaction can't be stored twice.
  const sig = e.metadata && e.metadata.txSignature;
  if (sig) row.tx_signature = sig;
  return row;
}

function rowToEvent(r) {
  const e = { id: r.id, timestamp: Number(r.timestamp), type: r.type };
  for (const [col, field] of Object.entries(FIELD_BY_COLUMN)) {
    if (r[col] === null || r[col] === undefined) continue;
    e[field] = NUMERIC_FIELDS.has(field) ? Number(r[col]) : r[col];
  }
  if (r.type === "payment_received") {
    // Payment details live in event.metadata locally and are flat in the row's metadata column.
    const { txSignature, network, token, from, ...rest } = r.metadata || {};
    Object.assign(e, rest);
    e.metadata = { txSignature: r.tx_signature || txSignature || null, network: network ?? null, token: token ?? null, from: from ?? null };
    return e;
  }
  return Object.assign(e, r.metadata || {});
}

/** Same uuid for the same legacy (id-less) event on every boot: hash of its content + its n-th occurrence. */
function legacyEventId(e, occurrence) {
  const h = crypto.createHash("sha256").update(`${JSON.stringify(e)}#${occurrence}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const emptyRollup = () => ({ countsByType: {}, totalRevenueUsd: 0, totalCostUsd: 0, totalExpectedRevenueUsd: 0, totalConfirmedPaymentsUsd: 0 });

// The idempotency index (`_recordedFinancialTaskIds`) is a Map of
// "<type>:<taskId>" -> event timestamp, in insertion order, capped at
// MAX_FINANCIAL_IDS (default 10,000; the OLDEST keys are evicted first — a
// duplicate retry arrives shortly after the original, not months later) and
// kept in sync with the retained events by prune().
const DEFAULT_MAX_FINANCIAL_IDS = 10000;
function resolveMaxFinancialIds(option) {
  for (const v of [option, process.env.MAX_FINANCIAL_IDS]) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_FINANCIAL_IDS;
}
const financialKey = (e) => `${e.type}:${e.taskId}`;
const isIndexed = (e) => FINANCIAL_TYPES.has(e.type) && Boolean(e.taskId);

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
  /**
   * @param {{ persistDir?: string, encryptionKey?: string, supabase?: SupabaseState }} [opts]
   * STORAGE: in-memory state + local files in `persistDir` (the fallback) are
   * unchanged. When SUPABASE_URL/SUPABASE_SERVICE_KEY are set, every event is
   * also mirrored to Supabase (write-behind) and `await init()` merges
   * Supabase's history into memory at startup, so data survives a redeploy
   * that wipes the local disk. Supabase failures never throw out of here.
   */
  constructor({ persistDir, encryptionKey, supabase, maxFinancialIds } = {}) {
    this._maxFinancialIds = resolveMaxFinancialIds(maxFinancialIds);
    this._remote = supabase || new SupabaseState();
    this._remoteEnabled = this._remote.enabled;
    this._queue = new WriteBehindQueue({ label: "economics", reconcile: () => this._reconcile() });
    this._hydrated = false;
    this._initPromise = null;
    this._log = persistDir ? new AppendLog(path.join(persistDir, "economic-events.jsonl"), { encryptionKey }) : null;
    this._rollupStore = persistDir ? new JsonFileStore(path.join(persistDir, "economic-rollup.json"), { encryptionKey }) : null;
    this.events = this._log ? this._log.loadAll() : [];
    this.rollup = this._rollupStore
      ? this._rollupStore.load(emptyRollup())
      : emptyRollup();
    // Older persisted rollups won't have these two fields — default them.
    this.rollup.totalExpectedRevenueUsd = this.rollup.totalExpectedRevenueUsd || 0;
    this.rollup.totalConfirmedPaymentsUsd = this.rollup.totalConfirmedPaymentsUsd || 0;

    // Incremental mirror of whatever is currently in `this.events`, kept in
    // sync by record()/prune() so summary() never has to rescan events.
    this._live = { countsByType: {}, totalRevenueUsd: 0, totalCostUsd: 0, totalExpectedRevenueUsd: 0, totalConfirmedPaymentsUsd: 0 };
    for (const e of this.events) this._addToLive(e);

    // IDEMPOTENCY (requested explicitly: "تأكد من تسجيل task_completed...
    // مرة واحدة فقط"): a financial event (task_completed/task_failed) for
    // the same taskId must only ever be counted once, no matter how many
    // times record() is called for it — a retried delivery after a crash,
    // a duplicate webhook, or a double call from a bug should never double
    // revenue/cost. Rebuilt from history on construction so this holds
    // across restarts, not just within one process's memory.
    this._recordedFinancialTaskIds = new Map();
    this._reindexFinancial();
    if (this._remoteEnabled) this._ensureEventIds();

    // A real on-chain signature (when known) is a second guard: one transaction
    // can never be counted for two different tasks.
    this._recordedTxSignatures = new Set();
    for (const e of this.events) {
      const sig = e.type === "payment_received" && e.metadata && e.metadata.txSignature;
      if (sig) this._recordedTxSignatures.add(sig);
    }
  }

  /** Rebuilds the index from the retained events (oldest -> newest) and applies the cap. */
  _reindexFinancial() {
    this._recordedFinancialTaskIds = new Map();
    for (const e of this.events) {
      if (!isIndexed(e)) continue;
      const k = financialKey(e);
      this._recordedFinancialTaskIds.delete(k);
      this._recordedFinancialTaskIds.set(k, e.timestamp);
    }
    this._capFinancialIds();
  }

  _capFinancialIds() {
    const map = this._recordedFinancialTaskIds;
    while (map.size > this._maxFinancialIds) map.delete(map.keys().next().value);
  }

  _addToLive(e) {
    this._live.countsByType[e.type] = (this._live.countsByType[e.type] || 0) + 1;
    if (e.type === "task_completed") {
      this._live.totalRevenueUsd += e.revenueUsd || 0;
      this._live.totalCostUsd += e.costUsd || 0;
      this._live.totalExpectedRevenueUsd = (this._live.totalExpectedRevenueUsd || 0) + (e.expectedRevenueUsd || 0);
    }
    if (e.type === "payment_received") {
      this._live.totalConfirmedPaymentsUsd = (this._live.totalConfirmedPaymentsUsd || 0) + (e.amountUsd || 0);
    }
  }

  _removeFromLive(e) {
    this._live.countsByType[e.type] = (this._live.countsByType[e.type] || 0) - 1;
    if (e.type === "task_completed") {
      this._live.totalRevenueUsd -= e.revenueUsd || 0;
      this._live.totalCostUsd -= e.costUsd || 0;
      this._live.totalExpectedRevenueUsd = (this._live.totalExpectedRevenueUsd || 0) - (e.expectedRevenueUsd || 0);
    }
    if (e.type === "payment_received") {
      this._live.totalConfirmedPaymentsUsd = (this._live.totalConfirmedPaymentsUsd || 0) - (e.amountUsd || 0);
    }
  }

  /**
   * Returns the recorded entry, or `{ duplicate: true, ... }` without
   * writing anything if this exact financial outcome (type + taskId) was
   * already recorded — the caller should treat both the same way (the
   * work is "recorded"); only the caller needs to know whether a NEW
   * write happened if it cares about side effects like logging.
   * `taskId` is required for "task_completed"/"task_failed" specifically
   * — other event types (task_discovered, bid_won, moltbook posts, etc.)
   * aren't double-counting-sensitive in the same way and aren't deduped.
   */
  record(event) {
    const entry = { ...(this._remoteEnabled ? { id: crypto.randomUUID() } : {}), timestamp: Date.now(), ...event };
    if (isIndexed(entry)) {
      const dedupeKey = financialKey(entry);
      if (this._recordedFinancialTaskIds.has(dedupeKey)) {
        return { duplicate: true, type: entry.type, taskId: entry.taskId };
      }
      this._recordedFinancialTaskIds.set(dedupeKey, entry.timestamp);
      this._capFinancialIds();
    }
    this.events.push(entry);
    this._addToLive(entry);
    if (this._log) this._log.append(entry);
    this._mirrorEvent(entry);
    return entry;
  }

  /** e.g. { type: "task_discovered" | "task_accepted" | "task_rejected" | "bid_won" | "bid_lost" | "task_completed" | "task_failed" | "payment_received", ... } */

  /**
   * THE REAL revenue source (see paymentWatcher.js). A "task_completed"
   * event means the work was delivered — it is NOT proof anyone paid for
   * it. This is: real money actually arrived on-chain, confirmed by a
   * real transaction. `taskId` links it back to a specific task when a
   * memo was found on-chain (Solana supports this natively; Base/EVM
   * Transfer events don't carry a memo, so taskId may legitimately be
   * null there — see paymentWatcher.js's own notes). Idempotent by
   * `txSignature`, NOT by taskId: a real transaction signature/hash is
   * the only thing that uniquely identifies one real payment, and the
   * watcher re-scans a rolling window repeatedly, so it WILL see the
   * same real payment many times across cycles.
   * Idempotent by taskId (one payment per task); a known txSignature is a second guard.
   * @param {{ taskId: string, amountUsd: number, txSignature?: string, network?: string, token?: string, from?: string, connector?: string }} payment
   */
  recordPayment({ taskId, amountUsd, txSignature = null, network = null, token = null, from = null, connector } = {}) {
    if (!taskId) throw new Error("economics.recordPayment: taskId is required — it is the idempotency key (one payment per task).");
    if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || !(amountUsd > 0)) {
      throw new Error(`economics.recordPayment: amountUsd must be a positive number, got ${amountUsd}.`);
    }
    const dupe = { duplicate: true, type: "payment_received", taskId };
    if (txSignature && this._recordedTxSignatures.has(txSignature)) return { ...dupe, txSignature };
    const entry = {
      ...(this._remoteEnabled ? { id: crypto.randomUUID() } : {}),
      timestamp: Date.now(),
      type: "payment_received",
      taskId,
      amountUsd,
      ...(connector ? { connector } : {}),
      metadata: { txSignature, network, token, from },
    };
    const key = financialKey(entry);
    if (this._recordedFinancialTaskIds.has(key)) return dupe;
    this._recordedFinancialTaskIds.set(key, entry.timestamp);
    this._capFinancialIds();
    if (txSignature) this._recordedTxSignatures.add(txSignature);
    this.events.push(entry);
    this._addToLive(entry);
    if (this._log) this._log.append(entry);
    this._mirrorEvent(entry);
    return entry;
  }

  summary() {
    const byType = { ...this.rollup.countsByType };
    for (const [type, count] of Object.entries(this._live.countsByType)) {
      byType[type] = (byType[type] || 0) + count;
    }

    const legacyRevenue = this.rollup.totalRevenueUsd + this._live.totalRevenueUsd; // task_completed.revenueUsd (0 for new tasks)
    const cost = this.rollup.totalCostUsd + this._live.totalCostUsd;
    const expected = r6(this.rollup.totalExpectedRevenueUsd + this._live.totalExpectedRevenueUsd);
    const actual = r6(this.rollup.totalConfirmedPaymentsUsd + this._live.totalConfirmedPaymentsUsd);
    // Money counts as revenue only once it really arrived.
    const revenue = r6(legacyRevenue + actual);

    return {
      countsByType: byType,
      totalRevenueUsd: revenue,
      totalCostUsd: cost,
      totalProfitUsd: r6(revenue - cost),
      // Advertised rewards of delivered work: a pipeline estimate, never revenue.
      totalExpectedRevenueUsd: expected,
      // Payments really received (backed by recordPayment()).
      totalActualRevenueUsd: actual,
      totalConfirmedPaymentsUsd: actual, // alias kept for older callers
      // Delivered but not yet paid.
      pendingPaymentsUsd: r6(Math.max(0, expected - actual)),
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
        this.rollup.totalExpectedRevenueUsd += e.expectedRevenueUsd || 0;
      }
      if (e.type === "payment_received") {
        this.rollup.totalConfirmedPaymentsUsd += e.amountUsd || 0;
      }
      this._removeFromLive(e);
    }

    this.events = kept;
    if (this._log) this._log.rewrite(this.events);
    if (this._rollupStore) this._rollupStore.save(this.rollup);
    if (this._remoteEnabled && toRemove.length > 0) {
      // ONE transaction in Postgres: fold into the rollup + delete the rows.
      const ids = toRemove.map((e) => e.id).filter(Boolean);
      const rollup = JSON.parse(JSON.stringify(this.rollup));
      this._queue.push(() => this._remote.rpc("economic_prune", { p_ids: ids, p_rollup: rollup }));
    }

    // The index only ever describes retained events.
    const indexBefore = this._recordedFinancialTaskIds.size;
    this._reindexFinancial();
    this._recordedTxSignatures = new Set(
      this.events.filter((e) => e.type === "payment_received" && e.metadata && e.metadata.txSignature).map((e) => e.metadata.txSignature)
    );

    return { before, after: this.events.length, removed: before - this.events.length, dedupeKeysRemoved: Math.max(0, indexBefore - this._recordedFinancialTaskIds.size) };
  }

  // ---- Supabase replication -------------------------------------------------

  /** Give id-less (pre-Supabase) local events a stable id and persist it locally. */
  _ensureEventIds() {
    const seen = new Map();
    let changed = false;
    this.events = this.events.map((e) => {
      if (e.id) return e;
      const base = JSON.stringify(e);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      changed = true;
      return { id: legacyEventId(e, n), ...e };
    });
    if (changed && this._log) this._log.rewrite(this.events);
  }

  _rebuildDerivedState() {
    this._live = { countsByType: {}, totalRevenueUsd: 0, totalCostUsd: 0, totalExpectedRevenueUsd: 0, totalConfirmedPaymentsUsd: 0 };
    this._recordedTxSignatures = new Set();
    for (const e of this.events) {
      this._addToLive(e);
      const sig = e.type === "payment_received" && e.metadata && e.metadata.txSignature;
      if (sig) this._recordedTxSignatures.add(sig);
    }
    this._reindexFinancial();
  }

  /** Insert events, treating a unique-index 409 (already counted elsewhere) as "duplicate", not failure. */
  async _insertEvents(events) {
    const duplicates = [];
    const rows = events.map(eventToRow);
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      try {
        await this._remote.upsert("economic_events", batch, { onConflict: "id", mode: "ignore" });
      } catch (err) {
        if (err.status !== 409) throw err;
        for (const row of batch) {
          try {
            await this._remote.upsert("economic_events", [row], { onConflict: "id", mode: "ignore" });
          } catch (e2) {
            if (e2.status !== 409) throw e2;
            duplicates.push(row.id);
          }
        }
      }
    }
    return duplicates;
  }

  _mirrorEvent(entry) {
    if (!this._remoteEnabled) return;
    this._queue.push(async () => {
      const dup = await this._insertEvents([entry]);
      if (dup.length) this._dropDuplicate(entry);
    });
  }

  /** Supabase already has this payment/task outcome under another id: undo the local double count. */
  _dropDuplicate(entry) {
    const idx = this.events.indexOf(entry);
    if (idx === -1) return;
    this.events.splice(idx, 1);
    this._removeFromLive(entry);
    if (this._log) this._log.rewrite(this.events);
    console.warn(`[economics] ${entry.type} ${(entry.metadata && entry.metadata.txSignature) || entry.taskId || entry.id} already recorded in Supabase — not counted twice.`);
  }

  /**
   * Startup merge. Call once (and await it) before relying on summary():
   * Supabase history + this process's local fallback files are unioned by
   * event id; the rollup is Supabase's when it has one. Anything only the
   * local copy knows (recorded while Supabase was down) is pushed up.
   * Never rejects: if Supabase is unreachable, the local state simply stays.
   */
  init() {
    if (!this._remoteEnabled) return Promise.resolve();
    if (!this._initPromise) {
      this._initPromise = this._queue.push(() => this._hydrate()).then(() => undefined);
    }
    return this._initPromise;
  }

  async _hydrate() {
    const [rows, rollupRows] = await Promise.all([
      this._remote.selectAll("economic_events", "select=*&order=timestamp.asc,id.asc"),
      this._remote.selectAll("economic_rollup", "select=*&id=eq.1"),
    ]);
    this._ensureEventIds();

    const remoteEvents = rows.map(rowToEvent);
    const remoteIds = new Set(remoteEvents.map((e) => e.id));
    const remoteFinancialKeys = new Set(remoteEvents.filter((e) => FINANCIAL_TYPES.has(e.type) && e.taskId).map((e) => `${e.type}:${e.taskId}`));
    const remoteTx = new Set(remoteEvents.map((e) => e.metadata && e.metadata.txSignature).filter(Boolean));

    const localOnly = this.events.filter((e) => {
      if (remoteIds.has(e.id)) return false;
      if (FINANCIAL_TYPES.has(e.type) && e.taskId && remoteFinancialKeys.has(`${e.type}:${e.taskId}`)) return false; // already counted remotely
      const sig = e.metadata && e.metadata.txSignature;
      if (sig && remoteTx.has(sig)) return false;
      return true;
    });

    this.events = [...remoteEvents, ...localOnly].sort((a, b) => a.timestamp - b.timestamp);
    const remoteRollup = rollupRows[0] && rollupRows[0].data;
    if (remoteRollup) this.rollup = { ...emptyRollup(), ...remoteRollup };
    this._rebuildDerivedState();

    if (this._log) this._log.rewrite(this.events);
    if (this._rollupStore) this._rollupStore.save(this.rollup);
    this._hydrated = true;

    if (localOnly.length > 0) {
      const dup = await this._insertEvents(localOnly);
      for (const id of dup) {
        const e = this.events.find((x) => x.id === id);
        if (e) this._dropDuplicate(e);
      }
    }
    const rollupHasData = Object.keys(this.rollup.countsByType).length > 0;
    if (!remoteRollup && rollupHasData) {
      await this._remote.upsert("economic_rollup", [{ id: 1, data: this.rollup, updated_at: new Date().toISOString() }], { onConflict: "id", mode: "merge" });
    }
  }

  /** Re-push whatever Supabase is missing after an outage (runs on a timer while needed). */
  async _reconcile() {
    if (!this._hydrated) return this._hydrate();
    const remoteIds = new Set((await this._remote.selectAll("economic_events", "select=id")).map((r) => r.id));
    const missing = this.events.filter((e) => e.id && !remoteIds.has(e.id));
    if (missing.length === 0) return undefined;
    const dup = await this._insertEvents(missing);
    for (const id of dup) {
      const e = this.events.find((x) => x.id === id);
      if (e) this._dropDuplicate(e);
    }
    return undefined;
  }

  /** Resolves when every queued Supabase write has been attempted (used by tests and graceful shutdown). */
  flush() {
    return this._queue.flush();
  }
}

module.exports = EconomicIntelligence;
