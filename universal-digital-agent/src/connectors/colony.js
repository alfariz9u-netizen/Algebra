"use strict";

/**
 * Real connector for The Colony (https://thecolony.cc) — "the AI agent
 * internet." A social network where AI agents post findings, discuss ideas,
 * and DM each other. Free to register, free to read, free to post — this is
 * the primary channel for the "learn from other agents" requirement at
 * zero API cost (Colony itself; LLM calls to compose posts still apply).
 *
 * Docs used to build this: https://thecolony.cc/connect-agent,
 * https://thecolony.cc/api/v1 (register/post/search/message).
 *
 * REQUIRES:
 *   - COLONY_API_KEY — register for free: POST https://thecolony.cc/api/v1/auth/register
 *     (or via the human dashboard at thecolony.cc/my-agents)
 */

const API_BASE = process.env.COLONY_API_BASE || "https://thecolony.cc/api/v1";

class ColonyConnector {
  constructor() {
    this.name = "The Colony";
  }

  status() {
    return process.env.COLONY_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers() {
    if (!process.env.COLONY_API_KEY) {
      throw new Error(
        "COLONY_API_KEY is not set. Register for free at https://thecolony.cc/connect-agent"
      );
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.COLONY_API_KEY}`,
    };
  }

  /** One-time registration. Free, no approval process. */
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
    return data; // contains the col_... API key to store as COLONY_API_KEY
  }

  /** Learning input: search what other agents have posted about a topic. */
  async searchPosts(query, { colony = "general", limit = 10 } = {}) {
    const url = new URL(`${API_BASE}/posts/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("colony", colony);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    if (!response.ok) throw new Error(`Colony search failed: ${response.status}`);
    return response.json();
  }

  /**
   * Self-evolution input: share what THIS agent learned from a completed
   * task, so other agents (and future runs of this one) can search it later.
   */
  async postFinding({ title, body, colony = "general", postType = "finding" }) {
    const response = await fetch(`${API_BASE}/posts`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ title, body, colony, type: postType }),
    });
    if (!response.ok) throw new Error(`Colony post failed: ${response.status}`);
    return response.json();
  }

  async commentOnPost(postId, body) {
    const response = await fetch(`${API_BASE}/posts/${postId}/comments`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ body }),
    });
    if (!response.ok) throw new Error(`Colony comment failed: ${response.status}`);
    return response.json();
  }

  async sendMessage(userId, body) {
    const response = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ user_id: userId, body }),
    });
    if (!response.ok) throw new Error(`Colony DM failed: ${response.status}`);
    return response.json();
  }
}

module.exports = ColonyConnector;
