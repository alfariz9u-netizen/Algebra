"use strict";

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

function freshState() {
  // Always a brand-new set of objects — never share references with
  // DEFAULT_STATE or between instances, or two in-memory (no persistDir)
  // LearningEngine instances would silently mutate the same shared
  // circuits/deadOpportunities/connectorStats objects.
  return { circuits: {}, deadOpportunities: {}, connectorStats: {} };
}

/**
 * Classifies a thrown/rejected error into a failure kind so the circuit
 * breaker can react appropriately. This is the difference between "the
 * connector is fundamentally unusable right now" (stop hammering it) and
 * "this one listing happens to be broken" (skip just that listing) and
 * "the network hiccuped" (retry soon).
 *
 *   config          - CREDENTIAL_REQUIRED / NOT_SUPPORTED / NOT_CONNECTED:
 *                      will not resolve by retrying, only by an operator
 *                      fixing configuration.
 *   auth            - 401/403/"Unauthorized"/"Forbidden": credentials are
 *                      present but wrong/expired/insufficient. Same
 *                      "stop retrying until a human fixes it" treatment as
 *                      config, tracked separately only for clearer logs.
 *   rate_limit      - 429/"rate limit": will resolve on its own, soon.
 *   transient       - 5xx/timeout/network reset: will usually resolve on
 *                      its own, soon.
 *   listing_defect  - "no usable budget", 404, "insufficient data": a
 *                      property of ONE specific opportunity, not the
 *                      connector. Never opens the connector-wide circuit —
 *                      the caller should mark just that opportunity dead.
 *   unknown         - anything else: treated cautiously (short backoff).
 */
function classifyError(err) {
  const msg = String((err && err.message) || err || "");
  if (/CREDENTIAL_REQUIRED|NOT_SUPPORTED|NOT_CONNECTED|does not support/i.test(msg)) {
    return { kind: "config", retryable: false, perListing: false };
  }
  if (/\b401\b|unauthorized|\b403\b|forbidden|invalid[_ -]?api[_ -]?key/i.test(msg)) {
    return { kind: "auth", retryable: false, perListing: false };
  }
  if (/\b429\b|rate limit/i.test(msg)) {
    return { kind: "rate_limit", retryable: true, perListing: false };
  }
  if (/\b5\d\d\b|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network/i.test(msg)) {
    return { kind: "transient", retryable: true, perListing: false };
  }
  if (/no usable (budget|reward)|budget[=: ]*undefined|insufficient (listing )?data|\b404\b|not found/i.test(msg)) {
    return { kind: "listing_defect", retryable: false, perListing: true };
  }
  return { kind: "unknown", retryable: true, perListing: false };
}

// How many consecutive failures of a given kind before the circuit opens,
// how long the first "open" period lasts, and the ceiling it backs off to
// (doubling each time it re-opens right after a half-open trial fails).
// config/auth issues need a human, so they get long, patient backoffs;
// transient/rate-limit issues resolve themselves, so short ones.
const POLICY = {
  config: { threshold: 2, baseMs: 2 * 60 * 60 * 1000, capMs: 24 * 60 * 60 * 1000 },
  auth: { threshold: 2, baseMs: 2 * 60 * 60 * 1000, capMs: 24 * 60 * 60 * 1000 },
  rate_limit: { threshold: 3, baseMs: 2 * 60 * 1000, capMs: 30 * 60 * 1000 },
  transient: { threshold: 3, baseMs: 5 * 60 * 1000, capMs: 60 * 60 * 1000 },
  unknown: { threshold: 3, baseMs: 10 * 60 * 1000, capMs: 2 * 60 * 60 * 1000 },
};

function circuitKey(connector, operation) {
  return `${connector}::${operation}`;
}
function opportunityKey(connector, opportunityId) {
  return `${connector}::${opportunityId}`;
}

/**
 * Persisted failure memory + calibrated economics for MarketplacePipeline.
 * Exists to stop the exact pattern seen in production logs: the same
 * connector failing the exact same way (CREDENTIAL_REQUIRED, 401, "no
 * usable budget") every single cycle, forever, each time paying for a
 * fresh LLM-drafted proposal that was always going to be thrown away.
 *
 * Three independent pieces of memory:
 *   1. Circuit breaker per (connector, operation) — stops attempting an
 *      operation that keeps failing the same structural way, with
 *      exponential backoff, and automatically retries (half-open) once
 *      the backoff elapses rather than staying open forever.
 *   2. Dead-opportunity memory — remembers a specific listing (by id) that
 *      was already found unusable (e.g. no budget field) so it is never
 *      drafted-then-discarded again, even while the connector as a whole
 *      is healthy.
 *   3. Calibrated success probability — Bayesian blend of a strategy's
 *      static guess (e.g. "40% of Molt Market bids win") with this
 *      connector's own observed attempt/win history, so expected-value
 *      ranking gets more accurate the longer the agent runs instead of
 *      trusting a hand-picked constant forever.
 *
 * PERSISTENCE follows the same cross-process-safe pattern as KillSwitch:
 * `_sync()` re-reads from disk before every read, `_persist()` writes
 * immediately after every mutation.
 */
class LearningEngine {
  constructor({ persistDir, encryptionKey, now = () => Date.now() } = {}) {
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "learning-state.json"), { encryptionKey }) : null;
    this._now = now;
    const initial = this._store ? this._store.load(freshState()) : freshState();
    this.circuits = { ...(initial.circuits || {}) };
    this.deadOpportunities = { ...(initial.deadOpportunities || {}) };
    this.connectorStats = { ...(initial.connectorStats || {}) };
  }

  _sync() {
    if (!this._store) return;
    const state = this._store.load(freshState());
    this.circuits = { ...(state.circuits || {}) };
    this.deadOpportunities = { ...(state.deadOpportunities || {}) };
    this.connectorStats = { ...(state.connectorStats || {}) };
  }

  _persist() {
    if (!this._store) return;
    this._store.save({ circuits: this.circuits, deadOpportunities: this.deadOpportunities, connectorStats: this.connectorStats });
  }

  // ---- Circuit breaker -----------------------------------------------

  /**
   * Call BEFORE attempting an operation. Returns `{ open: true, ... }`
   * when the operation should be skipped entirely this cycle (no
   * connector call, no LLM draft, nothing spent). When the backoff window
   * has elapsed, transitions the circuit to "half_open" and allows exactly
   * one trial through (`open: false, halfOpen: true`) — success closes it,
   * failure re-opens it with a longer backoff.
   */
  checkCircuit(connector, operation) {
    this._sync();
    const key = circuitKey(connector, operation);
    const c = this.circuits[key];
    if (!c || c.state === "closed") return { open: false };

    const now = this._now();
    if (c.state === "open" && now < c.openUntil) {
      return { open: true, reason: c.lastError, kind: c.kind, retryAfterMs: c.openUntil - now, failureStreak: c.failureStreak };
    }
    // Backoff elapsed (or already half-open) — allow one trial through.
    c.state = "half_open";
    this._persist();
    return { open: false, halfOpen: true };
  }

  /** Call after an operation succeeds. Closes/resets its circuit. */
  recordSuccess(connector, operation) {
    this._sync();
    const key = circuitKey(connector, operation);
    if (this.circuits[key]) {
      this.circuits[key] = { state: "closed", failureStreak: 0 };
      this._persist();
    }
  }

  /**
   * Call after an operation fails. Returns `{ opened, kind, retryable,
   * perListing }` so the caller can decide whether to also mark a specific
   * opportunity dead (perListing) rather than blame the whole connector.
   * A `listing_defect` never touches the circuit at all — see classifyError.
   */
  recordFailure(connector, operation, err) {
    this._sync();
    const classification = classifyError(err);
    if (classification.perListing) return { opened: false, ...classification };

    const key = circuitKey(connector, operation);
    const policy = POLICY[classification.kind] || POLICY.unknown;
    const prev = this.circuits[key];
    const wasHalfOpen = Boolean(prev && prev.state === "half_open");
    const priorStreak = prev ? prev.failureStreak || 0 : 0;
    const failureStreak = priorStreak + 1;

    const shouldOpen = wasHalfOpen || failureStreak >= policy.threshold;
    if (!shouldOpen) {
      this.circuits[key] = { state: "closed", failureStreak, kind: classification.kind, lastError: String(err && err.message) };
      this._persist();
      return { opened: false, ...classification, failureStreak };
    }

    // Exponential backoff from the base, doubling for every re-open beyond
    // the first, capped so it never blocks forever past a sane ceiling.
    const reopenCount = wasHalfOpen ? (prev.reopenCount || 0) + 1 : 0;
    const backoffMs = Math.min(policy.baseMs * Math.pow(2, reopenCount), policy.capMs);
    const now = this._now();
    this.circuits[key] = {
      state: "open",
      failureStreak,
      reopenCount,
      kind: classification.kind,
      lastError: String(err && err.message),
      openedAt: now,
      openUntil: now + backoffMs,
    };
    this._persist();
    return { opened: true, retryAfterMs: backoffMs, ...classification, failureStreak };
  }

  /** Manual override — e.g. an operator ran a CLI command after fixing credentials. */
  resetCircuit(connector, operation) {
    this._sync();
    delete this.circuits[circuitKey(connector, operation)];
    this._persist();
  }

  // ---- Dead-opportunity memory -----------------------------------------

  isOpportunityDead(connector, opportunityId) {
    this._sync();
    return Boolean(this.deadOpportunities[opportunityKey(connector, opportunityId)]);
  }

  markOpportunityDead(connector, opportunityId, reason) {
    this._sync();
    this.deadOpportunities[opportunityKey(connector, opportunityId)] = { reason: String(reason || ""), at: this._now() };
    this._persist();
  }

  /** Splits a list of normalized opportunities into ones worth processing vs. already known-dead. */
  partitionKnownDead(connector, opportunities) {
    this._sync();
    const toProcess = [];
    const skipped = [];
    for (const opp of opportunities) {
      if (this.deadOpportunities[opportunityKey(connector, opp.id)]) skipped.push(opp);
      else toProcess.push(opp);
    }
    return { toProcess, skipped };
  }

  // ---- Calibrated success probability ----------------------------------

  /** Call whenever a bid/submission attempt is made, and whether it ultimately won/completed. */
  recordAttempt(connector, { won }) {
    this._sync();
    const stats = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    stats.attempts += 1;
    if (won) stats.wins += 1;
    this.connectorStats[connector] = stats;
    this._persist();
  }

  /**
   * Bayesian blend of a strategy's static guess (`fallback`, e.g. an env
   * var like MOLTMARKET_DEFAULT_BID_WIN_RATE) with this connector's own
   * observed win rate. With zero real attempts this returns exactly
   * `fallback` (no behavior change for a fresh agent); as attempts
   * accumulate, it converges toward the real observed rate. `priorWeight`
   * controls how many "virtual" attempts the fallback guess is worth —
   * higher means the static guess takes longer to be overridden by data.
   */
  calibratedSuccessProbability(connector, fallback, { priorWeight = 6 } = {}) {
    this._sync();
    const stats = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    const rate = (stats.wins + fallback * priorWeight) / (stats.attempts + priorWeight);
    return Math.min(0.99, Math.max(0.01, rate));
  }

  // ---- Housekeeping / visibility ----------------------------------------

  /** Drops resolved (closed) circuits and old dead-opportunity entries past maxAgeMs — keeps the state file bounded. */
  prune({ maxAgeMs } = {}) {
    this._sync();
    let removed = 0;
    for (const [key, c] of Object.entries(this.circuits)) {
      if (c.state === "closed") {
        delete this.circuits[key];
        removed += 1;
      }
    }
    if (maxAgeMs) {
      const cutoff = this._now() - maxAgeMs;
      for (const [key, d] of Object.entries(this.deadOpportunities)) {
        if (d.at < cutoff) {
          delete this.deadOpportunities[key];
          removed += 1;
        }
      }
    }
    this._persist();
    return { removed };
  }

  status() {
    this._sync();
    return { circuits: this.circuits, deadOpportunityCount: Object.keys(this.deadOpportunities).length, connectorStats: this.connectorStats };
  }
}

module.exports = LearningEngine;
module.exports.classifyError = classifyError;
