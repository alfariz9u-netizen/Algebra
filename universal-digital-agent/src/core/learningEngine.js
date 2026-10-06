"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

function freshState() { return { circuits: {}, deadOpportunities: {}, connectorStats: {} }; }

function classifyError(err) {
  const msg = String((err && err.message) || err || "");
  if (/CREDENTIAL_REQUIRED|NOT_SUPPORTED|NOT_CONNECTED|does not support/i.test(msg)) return { kind: "config", retryable: false, perListing: false };
  if (/\b401\b|unauthorized|\b403\b|forbidden|invalid[_ -]?api[_ -]?key/i.test(msg)) return { kind: "auth", retryable: false, perListing: false };
  if (/\b429\b|rate limit/i.test(msg)) return { kind: "rate_limit", retryable: true, perListing: false };
  if (/\b5\d\d\b|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network/i.test(msg)) return { kind: "transient", retryable: true, perListing: false };
  if (/no usable (budget|reward)|budget[=: ]*undefined|insufficient (listing )?data|\b404\b|not found/i.test(msg)) return { kind: "listing_defect", retryable: false, perListing: true };
  return { kind: "unknown", retryable: true, perListing: false };
}

const POLICY = {
  config: { threshold: 2, baseMs: 7200000, capMs: 86400000 },
  auth: { threshold: 2, baseMs: 7200000, capMs: 86400000 },
  rate_limit: { threshold: 3, baseMs: 120000, capMs: 1800000 },
  transient: { threshold: 3, baseMs: 300000, capMs: 3600000 },
  unknown: { threshold: 3, baseMs: 600000, capMs: 7200000 },
};

function jaccard(a, b) {
  const sa = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (!sa.size && !sb.size) return 1;
  let i = 0; for (const w of sa) if (sb.has(w)) i++;
  return i / (sa.size + sb.size - i);
}

class LearningEngine {
  constructor({ persistDir, encryptionKey, now = () => Date.now() } = {}) {
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "learning-state.json"), { encryptionKey }) : null;
    this._now = now;
    const s = this._store ? this._store.load(freshState()) : freshState();
    this.circuits = { ...(s.circuits || {}) };
    this.deadOpportunities = { ...(s.deadOpportunities || {}) };
    this.connectorStats = { ...(s.connectorStats || {}) };
  }
  // FIX (performance, optional): _sync() used to do a full file read +
  // JSON.parse (+ decrypt, when PERSIST_ENCRYPTION_KEY is set) on EVERY
  // call — and it's called from nearly every public method here
  // (recordFailure, recordAttempt, isOpportunityDead,
  // calibratedSuccessProbability, resetCircuit, ...), potentially many
  // times per 30-minute marketplace cycle across 9+ strategies. A
  // fs.statSync() first is dramatically cheaper than a full read+parse,
  // and lets every call skip the real work entirely when nothing has
  // changed on disk since the last sync — the common case within one
  // cycle, where most of these calls happen back-to-back with no write
  // in between. Falls back to the original always-reload behavior if
  // stat() fails for any reason other than the file not existing yet.
  _sync() {
    if (!this._store) return;
    try {
      const mtimeMs = fs.statSync(this._store.filePath).mtimeMs;
      if (this._lastSyncedMtimeMs === mtimeMs) return; // unchanged — skip the real read
      this._lastSyncedMtimeMs = mtimeMs;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // File doesn't exist yet — fall through to load(), which already
      // handles ENOENT by returning the default state.
    }
    const s = this._store.load(freshState());
    this.circuits = { ...(s.circuits || {}) };
    this.deadOpportunities = { ...(s.deadOpportunities || {}) };
    this.connectorStats = { ...(s.connectorStats || {}) };
  }
  _persist() { if (!this._store) return; this._store.save({ circuits: this.circuits, deadOpportunities: this.deadOpportunities, connectorStats: this.connectorStats }); }

  checkCircuit(connector, operation) {
    this._sync();
    const k = `${connector}::${operation}`;
    const c = this.circuits[k];
    if (!c || c.state === "closed") return { open: false };
    const now = this._now();
    if (c.state === "open" && now < c.openUntil) return { open: true, reason: c.lastError, kind: c.kind, retryAfterMs: c.openUntil - now, failureStreak: c.failureStreak };
    c.state = "half_open"; this._persist();
    return { open: false, halfOpen: true };
  }

  recordSuccess(connector, operation) {
    this._sync();
    const k = `${connector}::${operation}`;
    if (this.circuits[k]) { this.circuits[k] = { state: "closed", failureStreak: 0 }; this._persist(); }
  }

  recordFailure(connector, operation, err) {
    this._sync();
    const cl = classifyError(err);
    if (cl.perListing) return { opened: false, ...cl };
    const k = `${connector}::${operation}`;
    const p = POLICY[cl.kind] || POLICY.unknown;
    const prev = this.circuits[k];
    const wasHalf = !!(prev && prev.state === "half_open");
    const streak = (prev ? prev.failureStreak || 0 : 0) + 1;
    if (!wasHalf && streak < p.threshold) {
      this.circuits[k] = { state: "closed", failureStreak: streak, kind: cl.kind, lastError: String(err && err.message) };
      this._persist();
      return { opened: false, ...cl, failureStreak: streak };
    }
    const reopen = wasHalf ? (prev.reopenCount || 0) + 1 : 0;
    const backoff = Math.min(p.baseMs * Math.pow(2, reopen), p.capMs);
    const now = this._now();
    this.circuits[k] = { state: "open", failureStreak: streak, reopenCount: reopen, kind: cl.kind, lastError: String(err && err.message), openedAt: now, openUntil: now + backoff };
    this._persist();
    return { opened: true, retryAfterMs: backoff, ...cl, failureStreak: streak };
  }

  resetCircuit(connector, operation) { this._sync(); delete this.circuits[`${connector}::${operation}`]; this._persist(); }
  isOpportunityDead(connector, id) { this._sync(); return !!this.deadOpportunities[`${connector}::${id}`]; }
  markOpportunityDead(connector, id, reason) { this._sync(); this.deadOpportunities[`${connector}::${id}`] = { reason: String(reason || ""), at: this._now() }; this._persist(); }

  partitionKnownDead(connector, opps) {
    this._sync();
    const toProcess = [], skipped = [];
    for (const o of opps) { if (this.deadOpportunities[`${connector}::${o.id}`]) skipped.push(o); else toProcess.push(o); }
    return { toProcess, skipped };
  }

  recordAttempt(connector, { won }) {
    this._sync();
    const s = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    s.attempts += 1; if (won) s.wins += 1;
    this.connectorStats[connector] = s; this._persist();
  }

  calibratedSuccessProbability(connector, fallback, { priorWeight = 6 } = {}) {
    this._sync();
    const s = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    const r = (s.wins + fallback * priorWeight) / (s.attempts + priorWeight);
    return Math.min(0.99, Math.max(0.01, r));
  }

  async rememberTaskOutcome(supabase, { taskType, connector, capability, outcome, rewardUsd } = {}) {
    if (!supabase || supabase.status() !== "CONNECTED") return { stored: false, reason: "supabase not connected" };
    if (!outcome || outcome.status !== "success") return { stored: false, reason: "not successful" };
    const text = String(outcome.output || "").trim();
    if (text.length < 200) return { stored: false, reason: `too short (${text.length})` };
    const content = `Task type: ${taskType || "?"}.\nConnector: ${connector || "?"}.\nCapability: ${capability || "?"}.\nApproach that worked:\n${text.slice(0, 1500)}`;
    const importance = Math.max(1, Math.min(10, Math.round(3 + (outcome.meta?.qaScore || 70) / 25)));
    // FIX: was computing the embedding here (just to read `.source` for
    // metadata) AND letting storeLesson() compute it again internally for
    // the exact same `content` — a real, avoidable double Jina-API-call
    // (or double SHA-256 pseudo-embedding) on every single lesson stored.
    // Computed once now and passed through via precomputedEmbedding.
    try {
      // FIX (found while adding the Jina-401-must-not-be-silent fix in
      // supabase.js): embedWithSource() used to be called OUTSIDE this
      // try/catch, which was invisible as long as it never threw — and it
      // never used to throw, since every failure path inside it quietly
      // returned a pseudo-embedding instead. Now that a 401/403 correctly
      // throws instead of masking itself, that exception propagated
      // straight out of rememberTaskOutcome(), breaking its contract
      // (every other caller, and this method's own other return paths,
      // expect it to always resolve to {stored, reason|importance}, never
      // reject). Moved inside the try so a real auth failure is reported
      // honestly via `reason`, exactly like any other failure here,
      // instead of either being silently masked (the old bug) or crashing
      // the caller (this one, caught only because of the fix below).
      const probe = await supabase.embedWithSource(content);
      // FIX (live log evidence, 2026-09-30): this row IS the actual
      // inserted Supabase record (storeLesson returns it via
      // `Prefer: return=representation`), but its `id` was being
      // discarded here — every single "[universalAgent] lesson stored"
      // log line printed `id=undefined`, always, for every lesson ever
      // stored. Threaded through now so the log (and any future caller
      // that wants to act on a specific lesson id, e.g. feedback) gets
      // the real value.
      const row = await supabase.storeLesson({
        content,
        taskType: taskType || null,
        connector: connector || null,
        outcome: "success",
        importance,
        metadata: { capability, embedding_source: probe.source, kind: "positive" },
        precomputedEmbedding: probe,
      });
      return { stored: true, importance, id: row?.id };
    } catch (e) {
      return { stored: false, reason: e.message };
    }
  }

  async recallRelevantLessons(supabase, query, { connector, taskType, count = 4, threshold = 0.55 } = {}) {
    if (!supabase || supabase.status() !== "CONNECTED") return [];
    if (!query || !String(query).trim()) return [];
    try {
      const rows = await supabase.searchLessons(String(query).slice(0, 4000), { threshold, count: Math.max(count * 3, 12), connector, taskType, minImportance: 3 });
      if (!Array.isArray(rows) || !rows.length) return [];
      const picked = []; let used = 0;
      for (const row of rows) {
        if (picked.length >= count) break;
        const c = String(row.content || "").slice(0, 700);
        if (used + c.length > 2200) continue;
        if (picked.some((p) => jaccard(p.content, c) > 0.85)) continue;
        picked.push({ id: row.id, content: c, kind: row?.metadata?.kind || "positive", importance: row.importance, similarity: row.similarity });
        used += c.length;
      }
      return picked;
    } catch (e) { console.warn(`[learning] recall failed: ${e.message}`); return []; }
  }

  async recordLessonFeedback(supabase, ids, { helped } = {}) {
    if (!Array.isArray(ids) || !ids.length || !supabase || supabase.status() !== "CONNECTED") return { updated: 0 };
    const delta = helped ? 1 : -1;
    let u = 0;
    for (const id of ids) { try { await supabase.adjustImportance(id, delta); u++; } catch (e) { /* ignore */ } }
    return { updated: u };
  }

  prune({ maxAgeMs } = {}) {
    this._sync();
    let r = 0;
    for (const [k, c] of Object.entries(this.circuits)) if (c.state === "closed") { delete this.circuits[k]; r++; }
    if (maxAgeMs) { const cut = this._now() - maxAgeMs; for (const [k, d] of Object.entries(this.deadOpportunities)) if (d.at < cut) { delete this.deadOpportunities[k]; r++; } }
    this._persist();
    return { removed: r };
  }

  status() {
    this._sync();
    return { circuits: this.circuits, deadOpportunityCount: Object.keys(this.deadOpportunities).length, connectorStats: this.connectorStats };
  }
}

module.exports = LearningEngine;
module.exports.classifyError = classifyError;
