"use strict";

/**
 * Real connector for Moltbook (https://www.moltbook.com) — the social
 * network for AI agents. Used here for two reputation-building actions:
 *   1. upvotePost()   — upvote a post (builds karma, the agent's
 *                       portable reputation score).
 *   2. commentOnPost() — leave a reply/comment on another agent's post.
 *
 * Docs used to build this:
 *   - https://www.moltbook.com/api/v1 (base URL, always with www)
 *   - Community-maintained api-reference.md (CloudSecurityAlliance/moltbook-skill)
 *   - apidog.com/blog/moltbook-api-ai-agents
 *
 * REQUIRES:
 *   - MOLTBOOK_API_KEY — from registering at POST /api/v1/agents/register.
 *                        Starts with "moltbook_sk_".
 *
 * RATE LIMITS (enforced by Moltbook itself, not this connector):
 *   - 1 post per 30 minutes
 *   - 50 comments per hour
 *   - 100 requests per minute
 *
 * IMPORTANT: Always use https://www.moltbook.com — without "www" the
 * redirect strips the Authorization header and every call 401s.
 */

const API_BASE = process.env.MOLTBOOK_API_BASE || "https://www.moltbook.com/api/v1";

class MoltbookConnector {
  constructor() {
    this.name = "Moltbook";
  }

  status() {
    return process.env.MOLTBOOK_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers(extra = {}) {
    if (!process.env.MOLTBOOK_API_KEY) {
      throw new Error(
        "MOLTBOOK_API_KEY is not set. Register an agent at POST https://www.moltbook.com/api/v1/agents/register first."
      );
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MOLTBOOK_API_KEY}`,
      ...extra,
    };
  }

  /** Every Moltbook response is unwrapped here so callers see the real body. */
  async _unwrap(response, label) {
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new Error(
        `Moltbook ${label} failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`
      );
    }
    return body;
  }

  // ---- Read (used to find posts worth engaging with) ----

  /** Global feed. sort: hot|new|top|rising. */
  async getFeed({ sort = "hot", limit = 10, submolt } = {}) {
    const url = new URL(`${API_BASE}/posts`);
    url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(limit));
    if (submolt) url.searchParams.set("submolt", submolt);
    const response = await fetch(url, { headers: this._headers() });
    return this._unwrap(response, "GET /posts");
  }

  /** Single post with its comments. */
  async getPost(postId) {
    const response = await fetch(`${API_BASE}/posts/${postId}`, { headers: this._headers() });
    return this._unwrap(response, `GET /posts/${postId}`);
  }

  /** Comments on a post. sort: new|best. */
  async getComments(postId, { sort = "best", limit = 20 } = {}) {
    const url = new URL(`${API_BASE}/posts/${postId}/comments`);
    url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    return this._unwrap(response, `GET /posts/${postId}/comments`);
  }

  /** Own profile — karma, comment count, etc. */
  async whoami() {
    const response = await fetch(`${API_BASE}/agents/me`, { headers: this._headers() });
    return this._unwrap(response, "GET /agents/me");
  }

  // ---- Reputation-building actions ----

  /**
   * Upvote a post. Response includes author info and a follow suggestion.
   * NOTE: voting is a toggle — calling twice on the same post undoes the
   * first upvote. The LearningEngine's dead-opportunity memory (or an
   * upstream seen-set) should prevent re-upvoting the same post id.
   */
  async upvotePost(postId) {
    const response = await fetch(`${API_BASE}/posts/${postId}/upvote`, {
      method: "POST",
      headers: this._headers(),
    });
    return this._unwrap(response, `POST /posts/${postId}/upvote`);
  }

  /** Downvote a post (kept for symmetry; not used by the reputation strategy). */
  async downvotePost(postId) {
    const response = await fetch(`${API_BASE}/posts/${postId}/downvote`, {
      method: "POST",
      headers: this._headers(),
    });
    return this._unwrap(response, `POST /posts/${postId}/downvote`);
  }

  /**
   * Leave a comment on a post. `parentId` turns it into a reply to an
   * existing comment instead of a top-level comment.
   *
   * Moltbook may return a `verification` object alongside the created
   * comment (a math challenge hidden in text). If present, the caller
   * must solve it and POST /api/v1/verify with the answer — otherwise the
   * comment stays unverified. This connector returns the raw response so
   * the strategy can decide whether to run verification (a separate
   * capability, not part of "commentOnPost").
   */
  async commentOnPost(postId, { content, parentId } = {}) {
    if (!content || !content.trim()) {
      throw new Error("Moltbook commentOnPost requires non-empty `content`.");
    }
    const body = { content };
    if (parentId) body.parent_id = parentId;

    const response = await fetch(`${API_BASE}/posts/${postId}/comments`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    return this._unwrap(response, `POST /posts/${postId}/comments`);
  }
}

module.exports = MoltbookConnector;
