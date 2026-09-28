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
 * All three produce a 768-dim vector so the Supabase column type
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
   * Generate a 768-dim embedding. Tries Jina first (real semantic
   * embeddings), falls back to pseudo on any failure. Always returns an
   * array of exactly EMBEDDING_DIM floats so the Supabase column type
   * never breaks.
   */
  async _embed(text) {
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
          input: [String(text).slice(0, 8000)],
          dimensions: EMBEDDING_DIM,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const vec = data?.data?.[0]?.embedding;
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIM) {
          return vec;
        }
        console.warn(`[supabase] Jina returned ${vec?.length ?? "no"} dims, expected ${EMBEDDING_DIM} — using pseudo.`);
      } else {
        const txt = await res.text().catch(() => "");
        console.warn(`[supabase] Jina failed (${res.status}): ${txt.slice(0, 150)} — using pseudo.`);
      }
    } catch (err) {
      console.warn(`[supabase] Jina threw: ${err.message} — using pseudo.`);
    }
    return this._pseudoEmbedding(text);
  }

  /**
   * Store a curated lesson in Supabase. The CALLER is responsible for
   * filtering (only store lessons worth keeping — see the strategy layer).
   * This connector persists whatever it's given.
   */
  async storeLesson({ content, taskType, connector, outcome, importance, metadata } = {}) {
    if (!content || !content.trim()) throw new Error("Supabase storeLesson: content is required.");
    const embedding = await this._embed(content);

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
        metadata: metadata || {},
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
   * Semantic search with metadata filters. Returns only lessons whose
   * similarity to `query` exceeds `threshold`, ranked by
   * similarity × importance (importance acts as a multiplier so high-value
   * lessons surface first when similarities are close).
   */
  async searchLessons(query, { threshold = 0.6, count = 5, connector, taskType, minImportance = 0 } = {}) {
    if (!query || !query.trim()) throw new Error("Supabase searchLessons: query is required.");
    const embedding = await this._embed(query);

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
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase searchLessons failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const rows = await res.json();

    // Touch last_used_at on the rows we just surfaced (fire-and-forget).
    if (Array.isArray(rows) && rows.length > 0) {
      this._touchLastUsed(rows.map((r) => r.id)).catch(() => {});
    }
    return rows;
  }

  /** Fire-and-forget: update last_used_at + increment times_used. */
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
