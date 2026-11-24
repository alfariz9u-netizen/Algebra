"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");
const { SupabaseState, WriteBehindQueue } = require("./persistence/supabaseState");

// Rows of the Supabase `learning_state` table (key -> jsonb value).
const REMOTE_KEYS = ["circuits", "deadOpportunities", "connectorStats", "contentFingerprints", "lessons"];

function freshState() { return { circuits: {}, deadOpportunities: {}, connectorStats: {}, contentFingerprints: {}, lessons: [] }; }

const MAX_FINGERPRINTS = Number(process.env.LEARNING_MAX_FINGERPRINTS || 5000);
const MAX_LOCAL_LESSONS = Number(process.env.LEARNING_MAX_LOCAL_LESSONS || 200);

/**
 * Order- and noise-insensitive fingerprint of a listing's text: the same job re-posted under a new id
 * (or with a different timestamp/number in the title) maps to the same value, so it is not drafted —
 * and paid for in tokens — a second time. Returns null for text too short to identify anything.
 */
function contentFingerprint(text) {
  const tokens = String(text || "").toLowerCase().replace(/[0-9]+/g, " ").split(/[^\p{L}]+/u).filter((w) => w.length > 2);
  if (tokens.length < 4) return null;
  const uniq = [...new Set(tokens)].sort();
  return require("node:crypto").createHash("sha1").update(uniq.join(" ")).digest("hex").slice(0, 20);
}

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
  /**
   * STORAGE: circuits, deadOpportunities and connectorStats live in memory
   * (the cache every method reads) and in `persistDir/learning-state.json`
   * (the fallback). When SUPABASE_URL/SUPABASE_SERVICE_KEY are set they are
   * also written to the `learning_state` table (debounced, so a burst of
   * recordFailure/recordAttempt calls is one write), `await init()` loads
   * them after a redeploy wiped the disk, and _sync() re-pulls at most once
   * per LEARNING_REMOTE_TTL_MS so Supabase isn't queried on every call.
   * Conflict rule: the side with the newer timestamp wins (last writer wins).
   */
  constructor({ persistDir, encryptionKey, now = () => Date.now(), supabase } = {}) {
    this._remote = supabase || new SupabaseState();
    this._remoteEnabled = this._remote.enabled;
    this._queue = new WriteBehindQueue({ label: "learning", reconcile: () => this._pushNow() });
    const ttl = Number(process.env.LEARNING_REMOTE_TTL_MS ?? 30000);
    this._remoteTtlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 30000;
    const debounce = Number(process.env.LEARNING_REMOTE_DEBOUNCE_MS ?? 500);
    this._debounceMs = Number.isFinite(debounce) && debounce >= 0 ? debounce : 500;
    this._lastRemotePull = 0;
    this._lastLocalWriteAt = 0;
    this._pushTimer = null;
    this._dirty = false;
    this._initPromise = null;
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "learning-state.json"), { encryptionKey }) : null;
    this._now = now;
    const s = this._store ? this._store.load(freshState()) : freshState();
    this.circuits = { ...(s.circuits || {}) };
    this.deadOpportunities = { ...(s.deadOpportunities || {}) };
    this.connectorStats = { ...(s.connectorStats || {}) };
    this.contentFingerprints = { ...(s.contentFingerprints || {}) };
    this.lessons = Array.isArray(s.lessons) ? [...s.lessons] : [];
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
    this._maybeRefreshRemote();
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
    this.contentFingerprints = { ...(s.contentFingerprints || {}) };
    this.lessons = Array.isArray(s.lessons) ? [...s.lessons] : [];
  }
  _snapshot() {
    return { circuits: this.circuits, deadOpportunities: this.deadOpportunities, connectorStats: this.connectorStats, contentFingerprints: this.contentFingerprints, lessons: this.lessons };
  }
  _persist() {
    if (this._store) {
      this._store.save(this._snapshot());
      try {
        this._lastSyncedMtimeMs = fs.statSync(this._store.filePath).mtimeMs; // our own write is not a foreign change
      } catch { /* ignore */ }
    }
    this._lastLocalWriteAt = Date.now();
    this._scheduleRemotePush();
  }

  // ---- Supabase replication -------------------------------------------------

  /** Loads (and merges) Supabase's state into memory. Never rejects. */
  init() {
    if (!this._remoteEnabled) return Promise.resolve();
    if (!this._initPromise) this._initPromise = this._queue.push(() => this._pullAndMerge({ force: true })).then(() => undefined);
    return this._initPromise;
  }

  /** Writes any debounced local changes to Supabase now and waits for the queue (tests, shutdown). */
  async flush() {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
      this._queuePush();
    }
    await this._queue.flush();
  }

  _scheduleRemotePush() {
    if (!this._remoteEnabled) return;
    this._dirty = true;
    if (this._pushTimer) return;
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      this._queuePush();
    }, this._debounceMs);
    if (this._pushTimer.unref) this._pushTimer.unref();
  }

  _queuePush() {
    this._queue.push(() => this._pushNow());
  }

  async _pushNow() {
    const stamp = new Date().toISOString();
    const rows = REMOTE_KEYS.map((key) => ({ key, value: JSON.parse(JSON.stringify(this[key])), updated_at: stamp }));
    this._dirty = false;
    try {
      await this._remote.upsert("learning_state", rows, { onConflict: "key", mode: "merge" });
    } catch (err) {
      this._dirty = true; // keep the "unsent changes" flag so a pull can't overwrite them
      throw err;
    }
  }

  _maybeRefreshRemote() {
    if (!this._remoteEnabled || Date.now() - this._lastRemotePull < this._remoteTtlMs) return;
    this._lastRemotePull = Date.now();
    this._queue.push(() => this._pullAndMerge({ force: false }));
  }

  async _pullAndMerge({ force }) {
    const rows = await this._remote.selectAll("learning_state", "select=*");
    this._lastRemotePull = Date.now();
    // Unsent local changes always win over a pull (otherwise our own debounced write would be undone).
    if (!force && (this._dirty || this._pushTimer)) return;
    const localTs = this._localTimestamp();
    let adopted = false;
    let needPush = false;
    for (const key of REMOTE_KEYS) {
      const row = rows.find((r) => r.key === key);
      if (!row) {
        if (Object.keys(this[key]).length > 0) needPush = true; // (arrays: length via keys too) // Supabase has none of this yet
        continue;
      }
      const remoteTs = new Date(row.updated_at).getTime() || 0;
      if (remoteTs >= localTs) {
        this[key] = Array.isArray(this[key]) ? (Array.isArray(row.value) ? row.value : []) : { ...(row.value || {}) };
        adopted = true;
      } else {
        needPush = true; // our copy is newer (e.g. recorded while Supabase was down)
      }
    }
    if (adopted && this._store) {
      this._store.save(this._snapshot());
      try {
        this._lastSyncedMtimeMs = fs.statSync(this._store.filePath).mtimeMs;
      } catch { /* ignore */ }
    }
    if (needPush) await this._pushNow();
  }

  /** When did this process's copy last change? Newer of the local file's mtime and our last in-memory write. */
  _localTimestamp() {
    let t = this._lastLocalWriteAt;
    if (this._store) {
      try {
        t = Math.max(t, fs.statSync(this._store.filePath).mtimeMs);
      } catch { /* no file yet */ }
    }
    return t;
  }

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

  /** A bid was ACCEPTED by the platform (the attempt itself was already counted when it was submitted). */
  recordWin(connector) {
    this._sync();
    const s = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    s.wins += 1;
    s.attempts = Math.max(s.attempts, s.wins);
    this.connectorStats[connector] = s; this._persist();
  }

  calibratedSuccessProbability(connector, fallback, { priorWeight = 6 } = {}) {
    this._sync();
    const s = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    const r = (s.wins + fallback * priorWeight) / (s.attempts + priorWeight);
    return Math.min(0.99, Math.max(0.01, r));
  }

  // ---- Content-level duplicate guard ---------------------------------------

  /** Has a listing with this (normalized) text already been handled on this connector? */
  isContentSeen(connector, text) {
    this._sync();
    const fp = contentFingerprint(text);
    return !!(fp && this.contentFingerprints[`${connector}::${fp}`]);
  }

  markContentSeen(connector, text, id) {
    this._sync();
    const fp = contentFingerprint(text);
    if (!fp) return false;
    this.contentFingerprints[`${connector}::${fp}`] = { at: this._now(), id: id == null ? null : String(id) };
    const keys = Object.keys(this.contentFingerprints);
    if (keys.length > MAX_FINGERPRINTS) {
      keys.sort((a, b) => this.contentFingerprints[a].at - this.contentFingerprints[b].at)
        .slice(0, keys.length - MAX_FINGERPRINTS)
        .forEach((k) => delete this.contentFingerprints[k]);
    }
    this._persist();
    return true;
  }

  /** Splits opportunities into new ones and re-posts of listings already handled (same text, new id). */
  partitionDuplicateContent(connector, opps, textOf) {
    this._sync();
    const fresh = [], duplicates = [];
    const batch = new Set();
    for (const o of opps) {
      const fp = contentFingerprint(textOf(o));
      const dup = fp && (this.contentFingerprints[`${connector}::${fp}`] || batch.has(fp));
      if (dup) duplicates.push(o); else { fresh.push(o); if (fp) batch.add(fp); }
    }
    return { fresh, duplicates };
  }

  // ---- Local lessons (work without Supabase; positive AND negative) ----------

  /**
   * kind "positive": an approach that passed QA/was accepted. kind "negative": what failed and why.
   * Identical lessons are merged (hits++) instead of stored again; the store is bounded.
   */
  addLocalLesson({ kind = "positive", taskType, connector, text, importance = 5 } = {}) {
    const body = String(text || "").trim().slice(0, 700);
    if (body.length < 20) return { stored: false, reason: "too short" };
    this._sync();
    const dup = this.lessons.find((l) => l.kind === kind && l.connector === (connector || null) && l.taskType === (taskType || null) && jaccard(l.text, body) > 0.85);
    if (dup) { dup.hits = (dup.hits || 1) + 1; dup.importance = Math.min(10, Math.max(dup.importance, importance)); dup.at = this._now(); this._persist(); return { stored: false, merged: true, id: dup.id }; }
    const id = `L${this._now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.lessons.push({ id, kind, taskType: taskType || null, connector: connector || null, text: body, importance, hits: 1, at: this._now() });
    if (this.lessons.length > MAX_LOCAL_LESSONS) {
      this.lessons.sort((a, b) => (b.importance + Math.log2(1 + (b.hits || 1))) - (a.importance + Math.log2(1 + (a.hits || 1))) || b.at - a.at);
      this.lessons.length = MAX_LOCAL_LESSONS;
    }
    this._persist();
    return { stored: true, id };
  }

  recallLocalLessons(query, { connector, taskType, count = 3, minSimilarity = 0.12 } = {}) {
    this._sync();
    const q = String(query || "");
    if (!q.trim() || !this.lessons.length) return [];
    return this.lessons
      .filter((l) => (!connector || !l.connector || l.connector === connector) && (!taskType || !l.taskType || l.taskType === taskType))
      .map((l) => ({ l, sim: jaccard(q, l.text) }))
      .filter((x) => x.sim >= minSimilarity)
      .sort((a, b) => (b.sim * (1 + b.l.importance / 10)) - (a.sim * (1 + a.l.importance / 10)))
      .slice(0, count)
      .map(({ l, sim }) => ({ id: l.id, content: l.text, kind: l.kind, importance: l.importance, similarity: sim, local: true }));
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
    return { circuits: this.circuits, deadOpportunityCount: Object.keys(this.deadOpportunities).length, connectorStats: this.connectorStats, knownContentCount: Object.keys(this.contentFingerprints).length, localLessonCount: this.lessons.length };
  }
}

module.exports = LearningEngine;
module.exports.classifyError = classifyError;
module.exports.contentFingerprint = contentFingerprint;
