"use strict";

/**
 * Real connector for The Colony (https://thecolony.cc) — "the AI agent
 * internet." A social network where AI agents post findings, discuss ideas,
 * and DM each other. Free to register, free to read, free to post.
 *
 * AUTH FIX (the 401 root cause — confirmed from /auth/token docs and a
 * live REQBIN response):
 * The opaque col_… API key is NOT a bearer credential. The Colony requires
 * a two-step exchange:
 *     POST /api/v1/auth/token  { "api_key": "col_…" }
 *       → { "access_token": "<JWT>", ... }
 * The JWT is valid for 24 hours and must be sent as the Authorization
 * bearer on all WRITE endpoints. Sending the raw col_ key directly returns
 * 401 AUTH_INVALID_TOKEN — which is exactly what the old code did, so
 * postFinding() failed on every call while searchPosts() appeared to work
 * (read endpoints don't require auth at all).
 *
 * POST SHAPE FIX (confirmed from a live REQBIN response):
 * POST /api/v1/posts requires:
 *     { colony_id: "<UUID>", post_type: "finding", title, body }
 * NOT { colony: "<name>", type: "..." } — the field is colony_id, it must
 * be a UUID, and it's `post_type` (not `type`). resolveColonyId() handles
 * the name → UUID lookup via GET /api/v1/colonies (cached).
 *
 * SEARCH RESPONSE FIX (confirmed from a live REQBIN response):
 * GET /api/v1/search?q=… returns { items: [...], total: N, users: [...] }.
 * The old code looked for `results`, so every search rendered as
 * "no results" — the API was fine, the parser was wrong.
 *
 * REQUIRES:
 *   - COLONY_API_KEY — register for free at https://thecolony.cc/connect-agent
 *     (or via POST /api/v1/auth/register from src/connectors/colony.js's
 *     static register() method).
 */

const API_BASE = process.env.COLONY_API_BASE || "https://thecolony.cc/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ColonyConnector {
  constructor() {
    this.name = "The Colony";
    // In-memory JWT cache. Tokens are valid 24h; we re-exchange on 401.
    this._jwt = null;
    this._jwtExpiresAt = 0;
    // Colony name/slug → UUID cache, populated lazily on first post.
    this._colonyCache = null;
  }

  status() {
    return process.env.COLONY_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  // ---- Authentication ----------------------------------------------------

  /**
   * Exchange the raw col_… API key for a 24-hour JWT. Cached in-process.
   * Called automatically by _authedFetch; callers never invoke it directly.
   * Pass force=true to bypass the cache after a 401.
   */
  async _getToken(force = false) {
    if (!process.env.COLONY_API_KEY) {
      throw new Error(
        "COLONY_API_KEY is not set. Register for free at https://thecolony.cc/connect-agent"
      );
    }
    const now = Date.now();
    if (!force && this._jwt && now < this._jwtExpiresAt) return this._jwt;

    const response = await fetch(`${API_BASE}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: process.env.COLONY_API_KEY }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `Colony token exchange failed: ${response.status} ${JSON.stringify(data).slice(0, 200)}`
      );
    }
    const token = data.access_token || data.token || data.jwt;
    if (!token) {
      throw new Error(
        `Colony token exchange returned no access_token: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
    this._jwt = token;
    // Refresh 5 minutes before the documented 24h expiry to avoid
    // edge-case 401s from clock skew or server-side revocation.
    this._jwtExpiresAt = now + 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
    return token;
  }

  /**
   * Authenticated fetch: attaches the JWT, and on 401 mints a fresh one
   * and retries once. Every write method below goes through this.
   */
  async _authedFetch(url, options = {}) {
    const doFetch = (token) =>
      fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });

    let token = await this._getToken();
    let response = await doFetch(token);

    if (response.status === 401) {
      // Token may have expired mid-session — force a fresh exchange, retry once.
      token = await this._getToken(true);
      response = await doFetch(token);
    }
    return response;
  }

  // ---- Registration (one-time, static) -----------------------------------

  /** One-time registration. Free. Returns the col_… key to store as COLONY_API_KEY. */
  static async register({ username, displayName, bio, skills = [] }) {
    const response = await fetch(`${API_BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        display_name: displayName,
        bio,
        capabilities: { skills },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Registration failed: ${response.status}`);
    }
    return data; // { api_key: "col_…", id, username, ... }
  }

  // ---- Read (no auth required, per Colony docs) --------------------------

  /**
   * Full-text search across posts and users.
   * Confirmed shape from a live response:
   *   { items: [...], total: N, has_more: bool, users: [...] }
   *
   * Read endpoints don't need auth — but we still try with a JWT first
   * (harmless), and fall back to unauthenticated on 401.
   */
  async searchPosts(query, { colonyName, limit = 10, sort = "relevance" } = {}) {
    const url = new URL(`${API_BASE}/search`);
    url.searchParams.set("q", query);
    if (colonyName) url.searchParams.set("colony_name", colonyName);
    if (sort) url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(limit));

    let response = await this._authedFetch(url);
    if (response.status === 401) {
      // Read endpoints should work unauthenticated — retry without auth.
      response = await fetch(url, { headers: { "Content-Type": "application/json" } });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony search failed: ${response.status} ${text.slice(0, 200)}`);
    }
    const data = await response.json();

    // One-shot shape log — first search per process prints the top-level
    // keys so a future "no results" bug is debuggable from logs alone.
    if (!globalThis.__colonySearchShapeLogged) {
      globalThis.__colonySearchShapeLogged = true;
      const shape = Array.isArray(data)
        ? `array(${data.length})`
        : `object[${Object.keys(data).slice(0, 15).join(",")}]`;
      const count = Array.isArray(data?.items) ? data.items.length : "n/a";
      console.log(`[colony] /search shape=${shape} items.length=${count}`);
    }

    // Normalize to a bare array for the caller. The Colony uses `items`
    // (confirmed), but we defensively accept `results` and a bare array too.
    const items =
      Array.isArray(data?.items) ? data.items :
      Array.isArray(data?.results) ? data.results :
      Array.isArray(data) ? data : [];

    // Preserve top-level metadata by returning an object with `.items`
    // AND making it array-like for callers that just want the list.
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      data.items = items;
      return data;
    }
    return { items, total: items.length };
  }

  /** List colonies (communities). Returns [{ id, name, slug, ... }]. */
  async listColonies() {
    const response = await this._authedFetch(`${API_BASE}/colonies`);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony list colonies failed: ${response.status} ${text.slice(0, 200)}`);
    }
    const data = await response.json();
    // Colony docs: GET /api/v1/colonies returns a bare JSON array.
    return Array.isArray(data) ? data : data.colonies || data.items || [];
  }

  /** Resolve a colony name/slug to its UUID, caching the full list. */
  async _resolveColonyId(nameOrId) {
    if (UUID_RE.test(nameOrId)) return nameOrId; // already a UUID
    if (!this._colonyCache) {
      this._colonyCache = await this.listColonies();
    }
    const match = this._colonyCache.find(
      (c) => c.name === nameOrId || c.slug === nameOrId || c.display_name === nameOrId
    );
    if (!match || !match.id) {
      const available = this._colonyCache
        .map((c) => c.name || c.slug)
        .slice(0, 10)
        .join(", ");
      throw new Error(
        `Colony: could not resolve "${nameOrId}" to a UUID. Available: ${available}`
      );
    }
    return match.id;
  }

  /** Get a specific post by id (with full body and comments count). */
  async getPost(postId) {
    const response = await this._authedFetch(`${API_BASE}/posts/${postId}`);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony getPost failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  // ---- Write (auth required) ---------------------------------------------

  /**
   * Share a finding on The Colony.
   * Confirmed shape: { colony_id: "<UUID>", post_type: "finding", title, body }.
   * post_type ∈ { finding, question, analysis, discussion, poll, human_request }.
   *
   * `colony` may be either a UUID or a colony name/slug. If it's a name, we
   * resolve it to a UUID via listColonies() (cached after the first call).
   */
  async postFinding({ title, body, colony = "general", postType = "finding" }) {
    if (!title || !title.trim()) throw new Error("Colony postFinding: title is required.");
    if (!body || !body.trim()) throw new Error("Colony postFinding: body is required.");

    const colonyId = await this._resolveColonyId(colony);
    const response = await this._authedFetch(`${API_BASE}/posts`, {
      method: "POST",
      body: JSON.stringify({
        colony_id: colonyId,
        post_type: postType,
        title: title.slice(0, 300),
        body,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony post failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  /** Comment on an existing post. */
  async commentOnPost(postId, body) {
    if (!body || !body.trim()) throw new Error("Colony commentOnPost: body is required.");
    const response = await this._authedFetch(`${API_BASE}/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony comment failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  /** Send a direct message to another Colony user. */
  async sendMessage(userId, body) {
    if (!userId) throw new Error("Colony sendMessage: userId is required.");
    if (!body || !body.trim()) throw new Error("Colony sendMessage: body is required.");
    const response = await this._authedFetch(`${API_BASE}/messages`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId, body }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony DM failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }
}

module.exports = ColonyConnector;
