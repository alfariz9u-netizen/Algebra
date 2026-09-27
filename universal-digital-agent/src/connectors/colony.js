"use strict";

/**
 * Real connector for The Colony (https://thecolony.cc) — the AI agent
 * internet. Free to register, free to read, free to post.
 *
 * AUTH FIX (the 401 root cause — confirmed from the official openapi.json):
 * The opaque col_… API key is NOT a bearer credential. The Colony's own
 * /auth/rotate-key docs state: "sending the key itself returns 401
 * AUTH_INVALID_TOKEN". Every authenticated request must instead carry a
 * short-lived JWT obtained by exchanging the key:
 *     POST /api/v1/auth/token  { "api_key": "col_…" }
 *       → { "access_token": "<JWT>", "token_type": "bearer" }
 * The JWT is valid for 24h. _authedFetch caches it in-process and, on any
 * 401, mints a fresh one and retries the request exactly once.
 *
 * NOTE ON READ ENDPOINTS: The Colony explicitly documents that read
 * endpoints (search, browse posts, list colonies) work WITHOUT auth. So
 * searchPosts() never needed the key in the first place — which is why it
 * appeared to "work" while postFinding() 401'd on every call.
 *
 * POST SHAPE FIX (also from openapi.json / API guide):
 * POST /api/v1/posts requires:
 *     { colony_id: "<UUID>", post_type: "finding", title, body }
 * NOT { colony: "<name>", type: "..." } — the field is colony_id and it
 * must be a UUID, not a colony name. resolveColonyId() handles the
 * name→UUID lookup via GET /api/v1/colonies.
 */

const API_BASE = process.env.COLONY_API_BASE || "https://thecolony.cc/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ColonyConnector {
  constructor() {
    this.name = "The Colony";
    this._jwt = null;
    this._jwtExpiresAt = 0;
    this._colonyCache = null; // name/slug → UUID, populated lazily
  }

  status() {
    return process.env.COLONY_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  // ---- Authentication ----------------------------------------------------

  /**
   * Exchange COLONY_API_KEY for a 24h JWT. Cached in-process. Called
   * automatically by _authedFetch; callers never invoke it directly.
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
    // Refresh 5 minutes before the documented 24h expiry.
    this._jwtExpiresAt = now + 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
    return token;
  }

  /**
   * Authenticated fetch: attaches the JWT, and on 401 mints a fresh one
   * and retries once. All authenticated methods go through this.
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
    if (!response.ok) throw new Error(data.error || `Registration failed: ${response.status}`);
    return data; // { api_key: "col_…", id, username, ... }
  }

  // ---- Read (no auth required, per Colony docs) --------------------------

  /**
   * Full-text search across posts and users.
   * Docs: GET /api/v1/search?q=…  → { results: [...], total: N }
   *
   * Note: this endpoint works WITHOUT auth. We still send the JWT when
   * we have one (harmless), but the call succeeds even before the token
   * exchange — which is why this was the only Colony operation that ever
   * "worked" before the auth fix.
   */
  async searchPosts(query, { colonyName, limit = 10, sort = "relevance" } = {}) {
    const url = new URL(`${API_BASE}/search`);
    url.searchParams.set("q", query);
    if (colonyName) url.searchParams.set("colony_name", colonyName);
    if (sort) url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(limit));

    // Try authenticated first (works even if endpoint is public); on a
    // 401 (shouldn't happen here) fall back to unauthenticated.
    let response = await this._authedFetch(url);
    if (response.status === 401) {
      response = await fetch(url, { headers: { "Content-Type": "application/json" } });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony search failed: ${response.status} ${text.slice(0, 200)}`);
    }
    const data = await response.json();

    // One-shot shape log — the first search on every deploy tells us the
    // real top-level keys, so a future "no results" bug is debuggable
    // from logs alone instead of guesswork.
    if (!globalThis.__colonySearchShapeLogged) {
      globalThis.__colonySearchShapeLogged = true;
      const shape = Array.isArray(data)
        ? `array(${data.length})`
        : `object[${Object.keys(data).slice(0, 15).join(",")}]`;
      const resultCount = Array.isArray(data?.results) ? data.results.length : "n/a";
      console.log(`[colony] /search shape=${shape} results.length=${resultCount}`);
    }

    return data;
  }

  /** List colonies (communities). Returns [{ id, name, slug, ... }]. */
  async listColonies() {
    const response = await this._authedFetch(`${API_BASE}/colonies`);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony list colonies failed: ${response.status} ${text.slice(0, 200)}`);
    }
    const data = await response.json();
    // Docs: GET /api/v1/colonies returns a bare JSON ARRAY.
    return Array.isArray(data) ? data : data.colonies || data.items || [];
  }

  /** Resolve a colony name/slug to its UUID, caching the full list. */
  async _resolveColonyId(nameOrId) {
    if (UUID_RE.test(nameOrId)) return nameOrId; // already a UUID
    if (!this._colonyCache) {
      this._colonyCache = await this.listColonies();
    }
    const match = this._colonyCache.find(
      (c) => c.name === nameOrId || c.slug === nameOrId
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

  // ---- Write (auth required) ---------------------------------------------

  /**
   * Share a finding on The Colony.
   * Docs: POST /api/v1/posts  { colony_id, post_type, title, body }
   * post_type ∈ { finding, question, analysis, discussion, poll, human_request }.
   */
  async postFinding({ title, body, colony = "general", postType = "finding" }) {
    const colonyId = await this._resolveColonyId(colony);
    const response = await this._authedFetch(`${API_BASE}/posts`, {
      method: "POST",
      body: JSON.stringify({
        colony_id: colonyId,
        post_type: postType,
        title,
        body,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Colony post failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  async commentOnPost(postId, body) {
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

  async sendMessage(userId, body) {
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
