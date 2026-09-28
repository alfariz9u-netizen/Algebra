"use strict";

/**
 * Real connector for Moltbook (https://www.moltbook.com) — the social
 * network for AI agents. Used here for:
 *   1. upvotePost()    — upvote (builds karma).
 *   2. commentOnPost() — leave a reply on another agent's post.
 *   3. createPost()    — publish a new top-level post to a submolt.
 *
 * VERIFICATION CHALLENGE:
 * Moltbook requires every published comment OR post to be verified by
 * solving an obfuscated lobster-themed math word problem within ~30
 * seconds. The response from POST /posts and POST /posts/:id/comments
 * includes a `verification` object:
 *   { verification_required: true,
 *     verification: { code, challenge, expires_at, instructions } }
 * solveChallenge() parses the text deterministically, and verifyChallenge()
 * POSTs the answer to /api/v1/verify. Without this step the content stays
 * unpublished.
 *
 * NOTE ON createPost:
 *   The endpoint is assumed to be POST /posts with { title, body, submolt }.
 *   This mirrors the shape documented by the community API reference for
 *   comments (POST /posts/:id/comments). If Moltbook's actual server
 *   rejects the field name (e.g. wants `colony` instead of `submolt`, or
 *   wants a `type` field), the thrown error will include the real server
 *   response body — see _unwrap(). This connector deliberately does not
 *   fabricate a payload shape beyond what is documented.
 *
 * REQUIRES:
 *   - MOLTBOOK_API_KEY — from registering at POST /api/v1/agents/register.
 *
 * RATE LIMITS (enforced by Moltbook itself):
 *   - 1 post per 30 minutes (established agents), 2 hours (new agents)
 *   - 50 comments per hour
 *   - 100 requests per minute
 *
 * IMPORTANT: Always use https://www.moltbook.com — without "www" the
 * redirect strips the Authorization header and every call 401s.
 */

const API_BASE = process.env.MOLTBOOK_API_BASE || "https://www.moltbook.com/api/v1";

// ---- Challenge solver ----------------------------------------------------

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

function normalizeChallengeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, " ")
    .replace(/(.)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumberPhrase(words) {
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (!(w in NUMBER_WORDS)) return null;
    const v = NUMBER_WORDS[w];
    if (v === 100) {
      current = (current || 1) * 100;
    } else if (v === 1000) {
      total += (current || 1) * 1000;
      current = 0;
    } else {
      current += v;
    }
  }
  return total + current;
}

function extractNumbers(normalized) {
  const results = [];

  const tokens = normalized.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    if (!(tokens[i] in NUMBER_WORDS)) continue;
    const seq = [tokens[i]];
    let j = i + 1;
    while (j < tokens.length && tokens[j] in NUMBER_WORDS) {
      seq.push(tokens[j]);
      j++;
    }
    const val = parseNumberPhrase(seq);
    if (val !== null) results.push({ value: val, position: i });
    i = j - 1;
  }

  const digitRe = /\b\d+(?:\.\d+)?\b/g;
  let m;
  while ((m = digitRe.exec(normalized)) !== null) {
    results.push({ value: parseFloat(m[0]), position: m.index });
  }

  const seen = new Set();
  return results
    .filter((r) => {
      const k = `${r.value}@${r.position}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.position - b.position);
}

const OPERATION_HINTS = [
  { keys: ["multipl", "times", "product", "per ", "each", "times as"], op: "*" },
  { keys: ["divid", "quotient", "split", "share", "per group"], op: "/" },
  { keys: ["subtract", "minus", "less", "differ", "remov", "left", "remain"], op: "-" },
  { keys: ["add", "plus", "total", "sum", "combined", "together", "altogeth"], op: "+" },
];

function detectOperation(normalized) {
  for (const { keys, op } of OPERATION_HINTS) {
    for (const k of keys) {
      if (normalized.includes(k)) return op;
    }
  }
  return null;
}

function solveChallenge(challengeText) {
  const normalized = normalizeChallengeText(challengeText);
  const numbers = extractNumbers(normalized);
  const op = detectOperation(normalized);

  if (!op) {
    throw new Error(`Moltbook challenge: no operation detected in "${challengeText.slice(0, 200)}"`);
  }
  if (numbers.length < 2) {
    throw new Error(`Moltbook challenge: expected 2 numbers, found ${numbers.length} in "${challengeText.slice(0, 200)}"`);
  }

  const a = numbers[0].value;
  const b = numbers[1].value;

  let result;
  switch (op) {
    case "*": result = a * b; break;
    case "/": result = b === 0 ? NaN : a / b; break;
    case "-": result = a - b; break;
    case "+": result = a + b; break;
    default: throw new Error(`Moltbook challenge: unsupported operation "${op}"`);
  }

  if (!Number.isFinite(result)) {
    throw new Error(`Moltbook challenge: non-finite result for ${a} ${op} ${b}`);
  }
  return result.toFixed(2);
}

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

  // ---- Read ----

  async getFeed({ sort = "hot", limit = 10, submolt } = {}) {
    const url = new URL(`${API_BASE}/posts`);
    url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(limit));
    if (submolt) url.searchParams.set("submolt", submolt);
    const response = await fetch(url, { headers: this._headers() });
    return this._unwrap(response, "GET /posts");
  }

  async getPost(postId) {
    const response = await fetch(`${API_BASE}/posts/${postId}`, { headers: this._headers() });
    return this._unwrap(response, `GET /posts/${postId}`);
  }

  async getComments(postId, { sort = "best", limit = 20 } = {}) {
    const url = new URL(`${API_BASE}/posts/${postId}/comments`);
    url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    return this._unwrap(response, `GET /posts/${postId}/comments`);
  }

  async whoami() {
    const response = await fetch(`${API_BASE}/agents/me`, { headers: this._headers() });
    return this._unwrap(response, "GET /agents/me");
  }

  // ---- Reputation-building actions ----

  async upvotePost(postId) {
    const response = await fetch(`${API_BASE}/posts/${postId}/upvote`, {
      method: "POST",
      headers: this._headers(),
    });
    return this._unwrap(response, `POST /posts/${postId}/upvote`);
  }

  async downvotePost(postId) {
    const response = await fetch(`${API_BASE}/posts/${postId}/downvote`, {
      method: "POST",
      headers: this._headers(),
    });
    return this._unwrap(response, `POST /posts/${postId}/downvote`);
  }

  /**
   * Publish a new top-level post.
   *
   * Moltbook's rate limit is 1 post per 30 minutes (established agents) or
   * 2 hours (new agents). The CALLER (strategies/moltbook.js) is
   * responsible for enforcing that — this connector does not.
   *
   * The response may contain a `verification` object, same shape as the
   * comment flow. Callers must solve + verify before the post becomes
   * visible.
   */
  async createPost({ title, body, submolt = "general" } = {}) {
    if (!title || !title.trim()) throw new Error("Moltbook createPost: title is required.");
    if (!body || !body.trim()) throw new Error("Moltbook createPost: body is required.");
    const response = await fetch(`${API_BASE}/posts`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ title, body, submolt }),
    });
    return this._unwrap(response, "POST /posts");
  }

  /**
   * Leave a comment on a post. `parentId` turns it into a reply to an
   * existing comment.
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

  // ---- Verification challenge ----

  extractChallenge(response) {
    if (!response || typeof response !== "object") return null;
    const v = response.verification;
    if (!v) return null;
    if (!v.code || !v.challenge) return null;
    return { code: v.code, challenge: v.challenge, expiresAt: v.expires_at };
  }

  solveChallenge(challengeText) {
    return solveChallenge(challengeText);
  }

  async verifyChallenge(verificationCode, answer) {
    if (!verificationCode) throw new Error("Moltbook verifyChallenge: verificationCode is required.");
    if (!answer) throw new Error("Moltbook verifyChallenge: answer is required.");
    const response = await fetch(`${API_BASE}/verify`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ verification_code: verificationCode, answer }),
    });
    return this._unwrap(response, "POST /verify");
  }
}

module.exports = MoltbookConnector;
