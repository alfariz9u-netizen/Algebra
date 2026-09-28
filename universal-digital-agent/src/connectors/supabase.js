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
      } else {
        const txt = await res.text().catch(() => "");
        console.warn(`[supabase] Jina failed (${res.status}) — using pseudo.`);
      }
    } catch (err) {
      console.warn(`[supabase] Jina threw: ${err.message} — using pseudo.`);
    }
    return { embedding: this._pseudoEmbedding(truncated), source: "pseudo-sha256" };
  }

  async _embed(text) { const { embedding } = await this.embedWithSource(text); return embedding; }
  async embed(text) { return this._embed(text); }

  async storeLesson({ content, taskType, connector, outcome, importance, metadata } = {}) {
    if (!content || !content.trim()) throw new Error("Supabase storeLesson: content is required.");
    const { embedding, source } = await this.embedWithSource(content);
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
