"use strict";

/**
 * Real connector for Moltbook (https://www.moltbook.com) — the social
 * network for AI agents. Used here for two reputation-building actions:
 *   1. upvotePost()   — upvote a post (builds karma, the agent's
 *                       portable reputation score).
 *   2. commentOnPost() — leave a reply/comment on another agent's post.
 *
 * VERIFICATION CHALLENGE (added):
 * Moltbook requires every posted comment to be verified by solving an
 * obfuscated lobster-themed math word problem within ~30 seconds. The
 * response from POST /posts/:id/comments includes a `verification` object:
 *   { verification_required: true,
 *     verification: { code, challenge, expires_at, instructions } }
 * solveChallenge() parses the obfuscated text deterministically (no LLM —
 * it's a math problem, not a reasoning task), and verifyChallenge() POSTs
 * the answer to /api/v1/verify. Without this step the comment stays
 * unpublished, so the whole reputation-building strategy silently wastes
 * every cycle.
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

// ---- Challenge solver ----------------------------------------------------

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

/**
 * Normalize obfuscated text: lowercase, strip punctuation, collapse any
 * run of the same letter to a single letter ("thhhhreeee" → "thre").
 * The challenge uses alternating case, injected punctuation, doubled
 * letters and filler words — this cancels all of them out.
 */
function normalizeChallengeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, " ")
    .replace(/(.)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a full English number phrase like "thirty two" or "one hundred
 * twenty" into an integer. Handles simple compounds up to thousands.
 */
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
    } else if (v >= 20) {
      current += v;
    } else {
      current += v;
    }
  }
  return total + current;
}

/**
 * Extract every number (digit or spelled-out) in order of appearance,
 * using the normalized text. Returns [{ value, start, end }, ...].
 */
function extractNumbers(normalized) {
  const results = [];

  // 1) Spelled-out numbers (possibly multi-word).
  const tokens = normalized.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    if (!(tokens[i] in NUMBER_WORDS)) continue;
    // Greedily consume consecutive number-words.
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

  // 2) Plain digit numbers.
  const digitRe = /\b\d+(?:\.\d+)?\b/g;
  let m;
  while ((m = digitRe.exec(normalized)) !== null) {
    results.push({ value: parseFloat(m[0]), position: m.index });
  }

  // Deduplicate by (value, position) preserving order.
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
  // Multi-word checks first (longest/most specific hints), then single.
  for (const { keys, op } of OPERATION_HINTS) {
    for (const k of keys) {
      if (normalized.includes(k)) return op;
    }
  }
  return null;
}

/**
 * Deterministically solve an obfuscated Moltbook math challenge.
 * Returns a string formatted to two decimals (e.g. "525.00"), or throws
 * if the challenge can't be parsed — better to fail loudly than to send
 * a wrong answer and risk the 10-strike account suspension.
 */
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

  // Use the first two numbers in order of appearance. The challenges are
  // designed with exactly two operands, so this is unambiguous.
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
  // Moltbook expects "X.00"-style two-decimal strings.
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
   * first upvote.
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
   * The response may contain a `verification` object. If it does, the
   * caller MUST solve it and call verifyChallenge() within ~30s, or the
   * comment never becomes visible.
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

  // ---- Verification challenge --------------------------------------------

  /**
   * Extract the { code, challenge } pair from a commentOnPost response.
   * Returns null when the response has no verification block (which
   * shouldn't normally happen for comments, but makes the caller robust).
   */
  extractChallenge(commentResponse) {
    if (!commentResponse || typeof commentResponse !== "object") return null;
    const v = commentResponse.verification;
    if (!v) return null;
    if (!v.code || !v.challenge) return null;
    return { code: v.code, challenge: v.challenge, expiresAt: v.expires_at };
  }

  /**
   * Solve a challenge string deterministically and return the answer as a
   * two-decimal string (e.g. "525.00"). Throws on parse failure so the
   * caller can log and skip instead of submitting a wrong answer.
   */
  solveChallenge(challengeText) {
    return solveChallenge(challengeText);
  }

  /**
   * Submit the answer to POST /api/v1/verify.
   * @param {string} verificationCode - the `code` from extractChallenge().
   * @param {string} answer - two-decimal string, e.g. "525.00".
   */
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
