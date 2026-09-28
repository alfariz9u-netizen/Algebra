"use strict";

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

function freshState() {
  return { circuits: {}, deadOpportunities: {}, connectorStats: {} };
}

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

// ---- Semantic-memory tuning ----------------------------------------------
const MIN_LESSON_CHARS = Number(process.env.LEARNING_MIN_LESSON_CHARS || 200);
const DEDUP_SIMILARITY_THRESHOLD = Number(process.env.LEARNING_DEDUP_THRESHOLD || 0.92);
// Recall budget: caps how many tokens of recalled lessons get injected into
// a single prompt. Each lesson is capped at RECALL_CHARS_PER_LESSON, and
// the total across all recalled lessons is capped at RECALL_TOTAL_CHARS.
const RECALL_CHARS_PER_LESSON = Number(process.env.LEARNING_RECALL_CHARS_PER_LESSON || 700);
const RECALL_TOTAL_CHARS = Number(process.env.LEARNING_RECALL_TOTAL_CHARS || 2200);
// Importance decays if a lesson hasn't been recalled in this many days.
// Prevents stale lessons from dominating ranking forever.
const IMPORTANCE_DECAY_DAYS = Number(process.env.LEARNING_DECAY_DAYS || 30);

/**
 * Persisted failure memory + calibrated economics + SEMANTIC LESSON MEMORY
 * for MarketplacePipeline.
 *
 * Semantic memory layers (all Supabase pgvector-backed):
 *   1. POSITIVE lessons — what worked, from successful tasks.
 *   2. NEGATIVE lessons — what to avoid, from repeated failures on the
 *      same connector+task-type after ≥3 distinct instances.
 *   3. Feedback-adjusted importance — a lesson's importance is nudged up
 *      when recall → success, and down when recall → failure.
 *
 * Filtering is deterministic (no LLM call to decide "is this worth
 * remembering"), because the pipeline is already token-constrained:
 *   - Only substantial, non-template outputs (≥ MIN_LESSON_CHARS) qualify.
 *   - Near-duplicates (similarity ≥ 0.92) are skipped at write time.
 *   - Recall returns a token-budgeted, deduplicated set: at most
 *     RECALL_TOTAL_CHARS total, and no two lessons >0.85 similar to each
 *     other inside the same prompt.
 *
 * EMBEDDING PROVENANCE: every lesson stores `embedding_source` in its
 * metadata (either "jina-v3" or "pseudo-sha256"). Recall only compares
 * against lessons from the same source, because comparing a real semantic
 * vector to a pseudo-hash vector produces noise, not similarity.
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

  // ---- Circuit breaker -------------------------------------------------

  checkCircuit(connector, operation) {
    this._sync();
    const key = circuitKey(connector, operation);
    const c = this.circuits[key];
    if (!c || c.state === "closed") return { open: false };

    const now = this._now();
    if (c.state === "open" && now < c.openUntil) {
      return { open: true, reason: c.lastError, kind: c.kind, retryAfterMs: c.openUntil - now, failureStreak: c.failureStreak };
    }
    c.state = "half_open";
    this._persist();
    return { open: false, halfOpen: true };
  }

  recordSuccess(connector, operation) {
    this._sync();
    const key = circuitKey(connector, operation);
    if (this.circuits[key]) {
      this.circuits[key] = { state: "closed", failureStreak: 0 };
      this._persist();
    }
  }

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

  recordAttempt(connector, { won }) {
    this._sync();
    const stats = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    stats.attempts += 1;
    if (won) stats.wins += 1;
    this.connectorStats[connector] = stats;
    this._persist();
  }

  calibratedSuccessProbability(connector, fallback, { priorWeight = 6 } = {}) {
    this._sync();
    const stats = this.connectorStats[connector] || { attempts: 0, wins: 0 };
    const rate = (stats.wins + fallback * priorWeight) / (stats.attempts + priorWeight);
    return Math.min(0.99, Math.max(0.01, rate));
  }

  // ---- SEMANTIC MEMORY: filter-first, LLM-free filtering ---------------

  /**
   * Deterministic filter for POSITIVE lessons. Returns { keep, reason }
   * and (when keep) the exact content that will be embedded.
   */
  _buildPositiveLesson({ taskType, connector, capability, output, rewardUsd, qaScore }) {
    const text = String(output || "").trim();

    if (text.length < MIN_LESSON_CHARS) {
      return { keep: false, reason: `output too short (${text.length} < ${MIN_LESSON_CHARS})` };
    }

    // Filter out template-y outputs that carry no reusable signal.
    // (Exact-duplicate detection happens in `_dedupCheck` below.)
    const looksTemplate = /^\s*(done|completed|ok|success)[.!]?\s*$/i.test(text);
    if (looksTemplate) return { keep: false, reason: "template output" };

    const content = [
      `Task type: ${taskType || "unknown"}.`,
      `Connector: ${connector || "unknown"}.`,
      `Capability: ${capability || "unknown"}.`,
      qaScore != null ? `QA score: ${qaScore}/100.` : null,
      rewardUsd ? `Reward: $${rewardUsd}.` : null,
      "Approach that worked:",
      text.slice(0, 1500),
    ].filter(Boolean).join("\n");

    // Importance heuristic, no LLM needed.
    const qaNorm = qaScore != null ? qaScore / 100 : 0.7;
    const rewardNorm = rewardUsd ? Math.min(1, rewardUsd / 5) : 0;
    const importance = Math.max(1, Math.min(10, Math.round(3 + qaNorm * 4 + rewardNorm * 3)));

    return { keep: true, content, importance };
  }

  /**
   * Deterministic filter for NEGATIVE lessons. Same shape as positive, but
   * only fires when the same connector+task-type has failed ≥3 times with
   * the same error kind — one-off failures don't deserve a permanent
   * "avoid this" entry.
   */
  _buildNegativeLesson({ taskType, connector, capability, errorMessage, errorKind }) {
    const text = String(errorMessage || "").trim();
    if (text.length < 40) return { keep: false, reason: "error too short" };

    const content = [
      `AVOID PATTERN (learned from repeated failure):`,
      `Task type: ${taskType || "unknown"}.`,
      `Connector: ${connector || "unknown"}.`,
      `Capability: ${capability || "unknown"}.`,
      `Failure kind: ${errorKind || "unknown"}.`,
      `Why it failed:`,
      text.slice(0, 800),
    ].join("\n");

    // Negative lessons default to modest importance (4); they only get
    // promoted if feedback shows they actually prevent failures.
    return { keep: true, content, importance: 4 };
  }

  async _dedupCheck(supabase, content, { connector, taskType, embeddingSource }) {
    try {
      const existing = await supabase.searchLessons(content, {
        threshold: DEDUP_SIMILARITY_THRESHOLD,
        count: 1,
        connector,
        taskType,
        embeddingSource,
      });
      if (Array.isArray(existing) && existing.length > 0) {
        return { duplicate: true, similarity: existing[0].similarity };
      }
    } catch (err) {
      console.warn(`[learning] dedup search failed: ${err.message} — storing anyway.`);
    }
    return { duplicate: false };
  }

  /**
   * Store a POSITIVE lesson learned from a successful task.
   * Fire-and-forget from the pipeline.
   */
  async rememberTaskOutcome(supabase, { taskType, connector, capability, outcome, rewardUsd } = {}) {
    if (!supabase || supabase.status() !== "CONNECTED") {
      return { stored: false, reason: "supabase not connected" };
    }
    if (!outcome || outcome.status !== "success") {
      return { stored: false, reason: "task not successful" };
    }

    const built = this._buildPositiveLesson({
      taskType, connector, capability,
      output: outcome.output,
      rewardUsd,
      qaScore: outcome.meta?.qaScore,
    });
    if (!built.keep) return { stored: false, reason: built.reason };

    // Embedding provenance — the connector returns the source it used.
    // If Jina succeeded, source = "jina-v3"; else "pseudo-sha256".
    // We need to know it BEFORE the dedup search, because we only want to
    // compare against same-source lessons.
    const probe = await supabase.embedWithSource(built.content);
    const embeddingSource = probe.source;

    const dedup = await this._dedupCheck(supabase, built.content, {
      connector, taskType, embeddingSource,
    });
    if (dedup.duplicate) {
      return { stored: false, reason: `near-duplicate (sim=${dedup.similarity?.toFixed(3)})` };
    }

    try {
      const stored = await supabase.storeLesson({
        content: built.content,
        taskType: taskType || null,
        connector: connector || null,
        outcome: "success",
        importance: built.importance,
        metadata: {
          capability,
          rewardUsd: rewardUsd || 0,
          qaScore: outcome.meta?.qaScore ?? null,
          embedding_source: embeddingSource,
          kind: "positive",
        },
      });
      return { stored: true, id: stored?.id, importance: built.importance };
    } catch (err) {
      return { stored: false, reason: `store failed: ${err.message}` };
    }
  }

  /**
   * Store a NEGATIVE lesson from a repeated failure. Called by the
   * pipeline after recordFailure() opens a circuit — this is when we
   * actually know "this pattern keeps failing" rather than "this one
   * attempt happened to fail".
   */
  async rememberTaskFailure(supabase, { taskType, connector, capability, errorMessage, errorKind } = {}) {
    if (!supabase || supabase.status() !== "CONNECTED") {
      return { stored: false, reason: "supabase not connected" };
    }

    const built = this._buildNegativeLesson({
      taskType, connector, capability, errorMessage, errorKind,
    });
    if (!built.keep) return { stored: false, reason: built.reason };

    const probe = await supabase.embedWithSource(built.content);
    const embeddingSource = probe.source;

    const dedup = await this._dedupCheck(supabase, built.content, {
      connector, taskType, embeddingSource,
    });
    if (dedup.duplicate) {
      return { stored: false, reason: `near-duplicate (sim=${dedup.similarity?.toFixed(3)})` };
    }

    try {
      const stored = await supabase.storeLesson({
        content: built.content,
        taskType: taskType || null,
        connector: connector || null,
        outcome: "failure",
        importance: built.importance,
        metadata: {
          capability,
          embedding_source: embeddingSource,
          kind: "negative",
          errorKind,
        },
      });
      return { stored: true, id: stored?.id, importance: built.importance };
    } catch (err) {
      return { stored: false, reason: `store failed: ${err.message}` };
    }
  }

  /**
   * Recall relevant lessons for a new task. Returns a token-budgeted,
   * diversity-filtered list. Each returned item is:
   *   { id, content, kind, importance, similarity, embedding_source }
   *
   * Diversity filter: we never return two lessons whose pairwise
   * similarity exceeds 0.85, so the prompt doesn't repeat itself.
   * (Pairwise check here is O(n²) but n is tiny — at most 5-6 items.)
   */
  async recallRelevantLessons(supabase, query, { connector, taskType, count = 4, threshold = 0.55, preferKinds = null } = {}) {
    if (!supabase || supabase.status() !== "CONNECTED") return [];
    if (!query || !String(query).trim()) return [];

    try {
      // Fetch a wider set than needed so we can dedupe/diversify.
      const rows = await supabase.searchLessons(String(query).slice(0, 4000), {
        threshold,
        count: Math.max(count * 3, 12),
        connector,
        taskType,
        minImportance: 3,
      });
      if (!Array.isArray(rows) || rows.length === 0) return [];

      // Filter by kind if requested.
      let candidates = rows;
      if (Array.isArray(preferKinds) && preferKinds.length > 0) {
        candidates = rows.filter((r) => {
          const kind = r?.metadata?.kind || "positive";
          return preferKinds.includes(kind);
        });
      }

      // Apply time-based importance decay. A lesson last used 90 days ago
      // is worth less than one used yesterday, even if its base importance
      // is higher.
      const now = this._now();
      const decayMs = IMPORTANCE_DECAY_DAYS * 24 * 60 * 60 * 1000;
      const scored = candidates.map((r) => {
        const lastUsed = r.last_used_at ? new Date(r.last_used_at).getTime() : 0;
        const ageMs = lastUsed > 0 ? now - lastUsed : decayMs;
        const decayFactor = Math.max(0.4, 1 - Math.min(1, ageMs / decayMs));
        return { ...r, _decayed: (r.score ?? r.similarity ?? 0) * decayFactor };
      }).sort((a, b) => b._decayed - a._decayed);

      // Greedy diversity: pick items whose similarity to already-picked
      // items is ≤ 0.85 (approximate by checking content Jaccard here,
      // since computing embeddings pairwise is expensive).
      const picked = [];
      const totalCharBudget = RECALL_TOTAL_CHARS;
      let used = 0;

      for (const row of scored) {
        if (picked.length >= count) break;
        const content = String(row.content || "").slice(0, RECALL_CHARS_PER_LESSON);
        if (used + content.length > totalCharBudget) continue;

        const tooSimilar = picked.some((p) => jaccard(p.content, content) > 0.85);
        if (tooSimilar) continue;

        picked.push({
          id: row.id,
          content,
          kind: row?.metadata?.kind || "positive",
          importance: row.importance,
          similarity: row.similarity,
          embedding_source: row?.metadata?.embedding_source || null,
        });
        used += content.length;
      }
      return picked;
    } catch (err) {
      console.warn(`[learning] recall failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Feedback loop: called after a task completes (or fails) whose prompt
   * included recalled lesson ids. Nudges the importance of each lesson
   * up (helped) or down (didn't help) so the memory self-tunes over time.
   */
  async recordLessonFeedback(supabase, lessonIds, { helped } = {}) {
    if (!Array.isArray(lessonIds) || lessonIds.length === 0) return { updated: 0 };
    if (!supabase || supabase.status() !== "CONNECTED") return { updated: 0 };
    const delta = helped ? +1 : -1;
    let updated = 0;
    for (const id of lessonIds) {
      try {
        await supabase.adjustImportance(id, delta);
        updated += 1;
      } catch (err) {
        console.warn(`[learning] feedback for ${id} failed: ${err.message}`);
      }
    }
    return { updated };
  }

  // ---- Housekeeping / visibility ----------------------------------------

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

// ---- Small helper: cheap content-similarity proxy ------------------------

function jaccard(a, b) {
  const setA = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

module.exports = LearningEngine;
module.exports.classifyError = classifyError;
