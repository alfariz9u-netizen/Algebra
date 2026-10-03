"use strict";
const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMBEDDING_DIM = 768;
const JINA_MODEL = process.env.JINA_EMBEDDING_MODEL || "jina-embeddings-v3";

class SupabaseConnector {
  constructor() { this.name = "Supabase"; }
  status() { return SUPABASE_URL && SUPABASE_SERVICE_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED"; }

  _headers(extra = {}) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Supabase not configured.");
    return {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...extra,
    };
  }

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

  async embedWithSource(text) {
    const truncated = String(text).slice(0, 8000);
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
      const res = await fetch("https://api.jina.ai/v1/embeddings", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: JINA_MODEL, input: [truncated], dimensions: EMBEDDING_DIM }),
      });
      if (res.ok) {
        const data = await res.json();
        const vec = data?.data?.[0]?.embedding;
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIM) return { embedding: vec, source: "jina-v3" };
        console.warn(`[supabase] Jina returned 200 but a malformed embedding shape — using pseudo.`);
        return { embedding: this._pseudoEmbedding(truncated), source: "pseudo-sha256" };
      } else if (res.status === 401 || res.status === 403) {
        // FIX (explicit rule: don't silently fall back on an auth
        // failure): a 401/403 means JINA_API_KEY is missing, wrong, or
        // revoked — a real, fixable configuration problem, not a
        // transient service hiccup. Silently degrading to a low-quality
        // SHA-256 pseudo-embedding here made this invisible forever: live
        // logs showed this exact message on literally every single cycle,
        // because nothing ever surfaced it as something to go fix. Now it
        // throws a clear, actionable error instead. This is safe — every
        // caller (learningEngine.rememberTaskOutcome/recallRelevantLessons)
        // already wraps this in try/catch and degrades gracefully (skips
        // the lesson, logs why) — so the system doesn't break, but the
        // real cause is no longer hidden behind a fake-looking success.
        throw new Error(
          `Jina embeddings API rejected the request (${res.status}): JINA_API_KEY is missing, invalid, or revoked. Fix the key — this is not a transient failure and will not resolve itself.`
        );
      } else {
        const txt = await res.text().catch(() => "");
        // Non-auth failures (5xx, timeout, network) are treated as
        // transient — degrading to pseudo-embedding here keeps lesson
        // storage/recall working at reduced quality rather than failing
        // every task outright, which is reasonable for a real outage.
        console.warn(`[supabase] Jina failed (${res.status}) — using pseudo. Response: ${txt.slice(0, 200)}`);
        return { embedding: this._pseudoEmbedding(truncated), source: "pseudo-sha256" };
      }
    } catch (err) {
      if (err.message.includes("JINA_API_KEY")) throw err; // the 401/403 case above — must propagate, not be masked here
      console.warn(`[supabase] Jina threw: ${err.message} — using pseudo.`);
      return { embedding: this._pseudoEmbedding(truncated), source: "pseudo-sha256" };
    }
  }

  async _embed(text) { const { embedding } = await this.embedWithSource(text); return embedding; }
  async embed(text) { return this._embed(text); }

  // FIX: accepts an optional pre-computed { embedding, source } (as
  // returned by embedWithSource()) so a caller that already needs the
  // embedding for another reason (learningEngine.rememberTaskOutcome used
  // to call embedWithSource() itself just to read `.source` for metadata,
  // then storeLesson() computed it AGAIN for the same content) doesn't
  // pay for the same Jina API call — or the same SHA-256 pseudo-embedding
  // — twice per stored lesson. When omitted, behavior is unchanged.
  async storeLesson({ content, taskType, connector, outcome, importance, metadata, precomputedEmbedding } = {}) {
    if (!content || !content.trim()) throw new Error("Supabase storeLesson: content is required.");
    const { embedding, source } = precomputedEmbedding || (await this.embedWithSource(content));
    const res = await fetch(`${SUPABASE_URL}/rest/v1/learnings`, {
      method: "POST",
      headers: this._headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        content: String(content).slice(0, 8000), embedding,
        task_type: taskType || null, connector: connector || null,
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

  async searchLessons(query, { threshold = 0.6, count = 5, connector, taskType, minImportance = 0, embeddingSource = null } = {}) {
    if (!query || !query.trim()) throw new Error("Supabase searchLessons: query is required.");
    const { embedding, source } = await this.embedWithSource(query);
    const effectiveSource = embeddingSource || source;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_learnings`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        query_embedding: embedding, match_threshold: threshold, match_count: count,
        filter_connector: connector || null, filter_task_type: taskType || null,
        min_importance: minImportance, filter_embedding_source: effectiveSource,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase searchLessons failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) this._touchLastUsed(rows.map((r) => r.id)).catch(() => {});
    return rows;
  }

  async adjustImportance(lessonId, delta) {
    if (!lessonId) throw new Error("Supabase adjustImportance: lessonId is required.");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/adjust_importance`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ lesson_id: lessonId, delta: Number(delta) || 0 }),
    });
    if (!res.ok) throw new Error(`Supabase adjustImportance failed: ${res.status}`);
    return res.json();
  }

  async _touchLastUsed(ids) {
    if (!ids || ids.length === 0) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/learnings?id=in.(${ids.map((i) => `"${i}"`).join(",")})`, {
        method: "PATCH",
        headers: this._headers({ Prefer: "return=minimal" }),
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      });
    } catch { /* ignore */ }
  }

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
