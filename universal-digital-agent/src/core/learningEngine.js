"use strict";

/**
 * Real connector for Supabase (https://supabase.com) — used here as the
 * agent's LONG-TERM SEMANTIC MEMORY. Unlike PERSIST_DIR (which Render
 * wipes on every redeploy), Supabase persists forever, so lessons the
 * agent learns today are still retrievable next month.
 *
 * Uses:
 *   - POST /rest/v1/learnings            → store a lesson (with its embedding)
 *   - POST /rest/v1/rpc/match_learnings  → semantic search with metadata filters
 *   - POST /rest/v1/rpc/adjust_importance → atomic +1/-1 nudge on a lesson
 *   - HEAD /rest/v1/learnings            → count total lessons
 *
 * EMBEDDING STRATEGY (three tiers, in order of preference):
 *   1. Jina AI (jina-embeddings-v3, 768 dims) — real semantic embeddings.
 *      Works with or without JINA_API_KEY. With a key: 500 req/min.
 *      Without a key: ~100 req/min (still plenty for this project).
 *   2. Pseudo-embedding (deterministic SHA-256 of the text) — NOT semantic,
 *      but deterministic (same input → same vector), so exact-text matches
 *      still work. Used only when Jina is unreachable.
 *
 * EMBEDDING PROVENANCE: `embedWithSource()` returns { embedding, source }.
 * Callers persist `source` alongside the lesson so recall only compares
 * against lessons from the same source — comparing a Jina vector to a
 * pseudo-hash vector is noise, not similarity.
 *
 * All paths produce a 768-dim vector so the Supabase column type
 * (vector(768)) stays valid across every fallback path.
 *
 * REQUIRES (in Render → Environment):
 *   - SUPABASE_URL          (e.g. https://xxx.supabase.co)
 *   - SUPABASE_SERVICE_KEY  (service_role JWT, bypasses RLS)
 *   - JINA_API_KEY          (optional — raises Jina rate limits)
 */

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMBEDDING_DIM = 768;

// Jina's v3 model supports dimensions: 256 | 512 | 768 | 1024 (Matryoshka).
// We pin 768 so it matches the vector(768) column type in Supabase.
const JINA_MODEL = process.env.JINA_EMBEDDING_MODEL || "jina-embeddings-v3";

class SupabaseConnector {
  constructor() {
    this.name = "Supabase";
  }

  status() {
    return SUPABASE_URL && SUPABASE_SERVICE_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers(extra = {}) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error("Supabase not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set.");
    }
    return {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...extra,
    };
  }

  /**
   * Deterministic fallback embedding — used only when Jina is unreachable.
   * NOT semantically meaningful (same-meaning text with different words
   * produces different vectors), but deterministic enough for exact-text
   * lookups. When Jina works, this is never used.
   */
  _pseudoEmbedding(text) {
    const hash = crypto.createHash("sha256").update(String(text)).digest();
    const vec = [];
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const b = hash[i % hash.length];
      vec.push((b / 255) * 2 - 1);
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  /**
   * Generate a 768-dim embedding AND tag which source produced it.
   *
   * Returns { embedding: number[], source: "jina-v3" | "pseudo-sha256" }.
   *
   * Callers persist `source` on the stored lesson (in metadata) and pass
   * it back as a filter during searchLessons(), so we never compare a
   * real semantic vector against a pseudo-hash vector.
   */
  async embedWithSource(text) {
    const truncated = String(text).slice(0, 8000);
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      // Jina works anonymously, but the API key lifts the rate limit.
      if (process.env.JINA_API_KEY) {
        headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
      }

      const res = await fetch("https://api.jina.ai/v1/embeddings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: JINA_MODEL,
          input: [truncated],
          dimensions: EMBEDDING_DIM,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const vec = data?.data?.[0]?.embedding;
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIM) {
          return { embedding: vec, source: "jina-v3" };
        }
        console.warn(`[supabase] Jina returned ${vec?.length ?? "no"} dims, expected ${EMBEDDING_DIM} — using pseudo.`);
      } else {
        const txt = await res.text().catch(() => "");
        console.warn(`[supabase] Jina failed (${res.status}): ${txt.slice(0, 150)} — using pseudo.`);
      }
    } catch (err) {
      console.warn(`[supabase] Jina threw: ${err.message} — using pseudo.`);
    }
    return { embedding: this._pseudoEmbedding(truncated), source: "pseudo-sha256" };
  }

  /**
   * Backwards-compatible alias — returns only the embedding array.
   * New code should prefer embedWithSource() so provenance is tracked.
   */
  async _embed(text) {
    const { embedding } = await this.embedWithSource(text);
    return embedding;
  }

  /** Public alias for _embed, for callers outside this class. */
  async embed(text) {
    return this._embed(text);
  }

  /**
   * Store a curated lesson in Supabase. The CALLER is responsible for
   * filtering (only store lessons worth keeping — see LearningEngine).
   *
   * `metadata.embedding_source` is set automatically from embedWithSource,
   * overriding whatever the caller passed — the source MUST match the
   * vector we actually computed, or the provenance filter breaks.
   */
  async storeLesson({ content, taskType, connector, outcome, importance, metadata } = {}) {
    if (!content || !content.trim()) throw new Error("Supabase storeLesson: content is required.");

    const { embedding, source } = await this.embedWithSource(content);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/learnings`, {
      method: "POST",
      headers: this._headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        content: String(content).slice(0, 8000),
        embedding,
        task_type: taskType || null,
        connector: connector || null,
        outcome: outcome || null,
        importance: typeof importance === "number" ? importance : 5,
        metadata: { ...(metadata || {}), embedding_source: source },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase storeLesson failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  }

  /**
   * Semantic search with metadata filters.
   *
   * The `embeddingSource` filter is required for correctness — mixing
   * vectors from different sources produces meaningless similarities.
   * If the caller omits it, we auto-detect by computing the query
   * embedding and using ITS source, which is the only source that can
   * produce meaningful similarity with the query.
   */
  async searchLessons(query, {
    threshold = 0.6,
    count = 5,
    connector,
    taskType,
    minImportance = 0,
    embeddingSource = null,
  } = {}) {
    if (!query || !query.trim()) throw new Error("Supabase searchLessons: query is required.");

    const { embedding, source } = await this.embedWithSource(query);
    const effectiveSource = embeddingSource || source;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_learnings`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: count,
        filter_connector: connector || null,
        filter_task_type: taskType || null,
        min_importance: minImportance,
        filter_embedding_source: effectiveSource,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase searchLessons failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const rows = await res.json();

    // Fire-and-forget: update last_used_at so the decay logic in
    // LearningEngine has data to work with.
    if (Array.isArray(rows) && rows.length > 0) {
      this._touchLastUsed(rows.map((r) => r.id)).catch(() => {});
    }
    return rows;
  }

  /**
   * Atomic importance nudge via RPC. Never read-then-write here — concurrent
   * feedback updates would clobber each other and we'd lose signals.
   *
   * delta: +1 to promote (lesson helped), -1 to demote (lesson didn't help).
   * The RPC clamps the result to [1, 10] server-side.
   */
  async adjustImportance(lessonId, delta) {
    if (!lessonId) throw new Error("Supabase adjustImportance: lessonId is required.");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/adjust_importance`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ lesson_id: lessonId, delta: Number(delta) || 0 }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase adjustImportance failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /** Fire-and-forget: update last_used_at on the given lesson ids. */
  async _touchLastUsed(ids) {
    if (!ids || ids.length === 0) return;
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/learnings?id=in.(${ids.map((i) => `"${i}"`).join(",")})`,
        {
          method: "PATCH",
          headers: this._headers({ Prefer: "return=minimal" }),
          body: JSON.stringify({
            last_used_at: new Date().toISOString(),
          }),
        }
      );
    } catch {
      /* best-effort; ignore failures */
    }
  }

  /** Count total lessons (used by /status dashboard). */
  async countLessons() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/learnings?select=id`, {
      method: "HEAD",
      headers: this._headers({ Prefer: "count=exact", Range: "0-0" }),
    });
    const range = res.headers.get("content-range");
    if (range && range.includes("/")) return parseInt(range.split("/")[1], 10) || 0;
    return 0;
  }
}

module.exports = SupabaseConnector;
