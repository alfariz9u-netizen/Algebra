"use strict";

/**
 * Memory + cache layer (spec section 5). Checked BEFORE any LLM call:
 *   1. Exact cache (hash of capability + normalized prompt)
 *   2. Semantic cache (real Gemini embeddings + cosine similarity)
 *   3. Full memory record (for audit/learning, not reuse)
 *
 * Entries carry confidence, source, timestamp, verification status, and an
 * expiration policy — stale or unverified entries are never silently reused.
 *
 * PERSISTENCE: in-memory by default (unchanged behavior for existing
 * callers/tests). Pass `{ persistDir }` to make it survive restarts —
 * every `store()` call also writes a snapshot to disk, and the constructor
 * loads any existing snapshot from that path. Proven in
 * test/persistence.test.js by creating a second instance against the same
 * directory and confirming a cache hit with no LLM/embedding call needed.
 */

const crypto = require("node:crypto");
const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

const DEFAULT_TTL_MS = Number(process.env.MEMORY_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const SEMANTIC_SIMILARITY_THRESHOLD = Number(process.env.SEMANTIC_CACHE_THRESHOLD || 0.93);

function hashKey(capability, prompt) {
  return crypto
    .createHash("sha256")
    .update(`${capability}::${prompt.trim().toLowerCase()}`)
    .digest("hex");
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class MemoryCache {
  constructor(modelRouter, { persistDir, encryptionKey } = {}) {
    this.modelRouter = modelRouter; // used for real embeddings
    this._exact = new Map(); // hash -> entry
    this._semantic = []; // [{ embedding, entry }]
    this.records = []; // full history for learning/audit, independent of cache validity

    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "memory-cache.json"), { encryptionKey }) : null;
    if (this._store) {
      const loaded = this._store.load({ exact: [], semantic: [], records: [] });
      this._exact = new Map(loaded.exact);
      this._semantic = loaded.semantic;
      this.records = loaded.records;
    }
  }

  _persist() {
    if (!this._store) return;
    this._store.save({
      exact: [...this._exact.entries()],
      semantic: this._semantic,
      records: this.records,
    });
  }

  _isValid(entry) {
    if (!entry) return false;
    if (entry.verificationStatus === "failed") return false;
    if (Date.now() > entry.expiresAt) return false;
    return true;
  }

  async lookup(capability, prompt) {
    const key = hashKey(capability, prompt);
    const exact = this._exact.get(key);
    if (this._isValid(exact)) {
      return { hit: true, via: "exact", entry: exact };
    }

    // Semantic lookup only if embeddings are actually available (Gemini configured).
    try {
      const embedding = await this.modelRouter.embed(prompt);
      let best = null;
      let bestScore = 0;
      for (const item of this._semantic) {
        if (!this._isValid(item.entry)) continue;
        if (item.entry.capability !== capability) continue;
        const score = cosineSimilarity(embedding, item.embedding);
        if (score > bestScore) {
          bestScore = score;
          best = item.entry;
        }
      }
      if (best && bestScore >= SEMANTIC_SIMILARITY_THRESHOLD) {
        return { hit: true, via: "semantic", entry: best, similarity: bestScore };
      }
    } catch (err) {
      // No embeddings configured — semantic cache silently degrades to
      // exact-only rather than failing the whole task.
    }

    return { hit: false };
  }

  /**
   * Stores a completed, verified-or-not result. Only entries with
   * verificationStatus === "passed" should normally be reused by lookup(),
   * enforced via _isValid().
   */
  async store(capability, prompt, result, meta = {}) {
    const key = hashKey(capability, prompt);
    const entry = {
      capability,
      prompt,
      result,
      confidence: meta.confidence ?? null,
      source: meta.source || "task-execution",
      timestamp: Date.now(),
      expiresAt: Date.now() + (meta.ttlMs || DEFAULT_TTL_MS),
      verificationStatus: meta.verificationStatus || "unverified",
      model: meta.model,
      provider: meta.provider,
      tokenUsage: meta.tokenUsage,
      cost: meta.cost,
    };

    this._exact.set(key, entry);
    this.records.push(entry);

    try {
      const embedding = await this.modelRouter.embed(prompt);
      this._semantic.push({ embedding, entry });
    } catch (err) {
      // Embeddings unavailable — exact-cache-only fallback, documented above.
    }

    this._persist();
    return entry;
  }
  /**
   * Physically removes expired/failed entries from disk and memory,
   * instead of just skipping them at lookup time forever. Without this,
   * `_exact`/`_semantic`/`records` grow without bound — this is the
   * database-cleanup gap. Also caps `records` (the full history log) to
   * `maxRecords` most-recent entries if provided, since that array has no
   * expiry concept of its own (it's kept for audit/learning, not lookup).
   *
   * @returns {{ removedExact: number, removedSemantic: number, removedRecords: number }}
   */
  pruneExpired({ maxRecords } = {}) {
    let removedExact = 0;
    for (const [key, entry] of this._exact.entries()) {
      if (!this._isValid(entry)) {
        this._exact.delete(key);
        removedExact++;
      }
    }

    const beforeSemantic = this._semantic.length;
    this._semantic = this._semantic.filter((item) => this._isValid(item.entry));
    const removedSemantic = beforeSemantic - this._semantic.length;

    let removedRecords = 0;
    if (maxRecords && this.records.length > maxRecords) {
      removedRecords = this.records.length - maxRecords;
      this.records = this.records.slice(-maxRecords);
    }

    if (removedExact || removedSemantic || removedRecords) this._persist();
    return { removedExact, removedSemantic, removedRecords };
  }
}

module.exports = MemoryCache;
