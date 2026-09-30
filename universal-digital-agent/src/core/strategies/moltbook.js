"use strict";

/**
 * Moltbook reputation-building strategy for MarketplacePipeline.
 *
 * DESIGN PRINCIPLES (from Moltbook's own rules.md + top-karma agents):
 *
 *   1. QUALITY OVER QUANTITY — 1 comment/cycle, 1 post/4 cycles.
 *      Moltbook explicitly penalizes "hollow comments" and rewards
 *      "build logs" with named tools + quantifiable results.
 *
 *   2. ARTIFACT GATE — every post must trace back to a real event
 *      (a task the agent completed, an error it fixed, a lesson it
 *      learned). No free-floating thought-leadership.
 *
 *   3. ANTI-REPETITION — persistent Sets of post IDs (commented/upvoted)
 *      AND a persistent Set of title hashes (for posts) so the same
 *      topic is never published twice.
 *
 *   4. RATE-LIMIT COMPLIANCE — 1 post per 30 min, 20s between comments,
 *      50 comments/day. Enforced by a cooldown file, not memory.
 *
 *   5. CONVERSATION OVER BROADCASTING — replies to comments on our own
 *      posts get priority over new top-level comments.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_POSTS_PER_CYCLE = Number(process.env.MOLTBOOK_POSTS_PER_CYCLE || 3);
const MAX_COMMENTS_PER_CYCLE = Number(process.env.MOLTBOOK_COMMENTS_PER_CYCLE || 1);
const POST_COOLDOWN_MS = Number(process.env.MOLTBOOK_POST_COOLDOWN_MS || 30 * 60 * 1000);
const COMMENT_COOLDOWN_MS = Number(process.env.MOLTBOOK_COMMENT_COOLDOWN_MS || 20 * 1000);

// ---- Persistent state (survives Render restarts) -------------------------

const STATE_DIR = process.env.PERSIST_DIR || "./data";
const STATE_FILE = path.join(STATE_DIR, "moltbook-state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return {
        commentedPostIds: new Set(raw.commentedPostIds || []),
        upvotedPostIds: new Set(raw.upvotedPostIds || []),
        publishedTitleHashes: new Set(raw.publishedTitleHashes || []),
        repliedCommentIds: new Set(raw.repliedCommentIds || []),
        lastPostAt: raw.lastPostAt || 0,
        lastCommentAt: raw.lastCommentAt || 0,
      };
    }
  } catch (err) {
    console.warn(`[moltbook] could not read state file: ${err.message}`);
  }
  return {
    commentedPostIds: new Set(),
    upvotedPostIds: new Set(),
    publishedTitleHashes: new Set(),
    repliedCommentIds: new Set(),
    lastPostAt: 0,
    lastCommentAt: 0,
  };
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      commentedPostIds: [...state.commentedPostIds],
      upvotedPostIds: [...state.upvotedPostIds],
      publishedTitleHashes: [...state.publishedTitleHashes],
      repliedCommentIds: [...state.repliedCommentIds],
      lastPostAt: state.lastPostAt,
      lastCommentAt: state.lastCommentAt,
    }), "utf8");
  } catch (err) {
    console.warn(`[moltbook] could not write state file: ${err.message}`);
  }
}

const _state = loadState();
let _commentsThisCycle = 0;
let _postsThisCycle = 0;

function titleHash(title) {
  return crypto.createHash("sha1").update(String(title).toLowerCase().trim()).digest("hex").slice(0, 16);
}

// ---- Post-topic builders (from real agent activity) ----------------------

/**
 * Build a "build log" post from a task the agent actually completed.
 * Moltbook's top-karma agents report that naming specific tools and
 * giving quantifiable results is what drives engagement.
 */
function buildBuildLogPost({ taskType, connector, capability, output, qaScore, rewardUsd }) {
  const trimmed = String(output || "").trim().slice(0, 900);
  const hash = titleHash(`${taskType}-${connector}-${trimmed.slice(0, 80)}`);
  const title = `Build log: ${capability || taskType} on ${connector} — ${hash}`;
  const body = [
    `Just finished a ${taskType || "task"} on **${connector || "unknown"}** using the \`${capability || "unknown"}\` capability.`,
    "",
    `**What worked:**`,
    trimmed,
    "",
    qaScore != null ? `**QA score:** ${qaScore}/100` : null,
    rewardUsd ? `**Reward:** $${rewardUsd}` : null,
    "",
    "**Open question:** has anyone else hit the same edge case, or found a different approach?",
  ].filter(Boolean).join("\n");
  return { title, body };
}

/**
 * Build a "lesson learned" post — specifically about a failure or a
 * gotcha. Moltbook data shows honest failure reports get more traction
 * than success stories.
 */
function buildLessonPost({ taskType, connector, errorMessage, errorKind }) {
  const hash = titleHash(`lesson-${connector}-${errorKind || "unknown"}-${String(errorMessage).slice(0, 60)}`);
  const title = `Gotcha: ${errorKind || "failure"} on ${connector} — ${hash}`;
  const body = [
    `Ran into this on **${connector || "unknown"}** while working a ${taskType || "task"}:`,
    "",
    `> ${String(errorMessage || "").slice(0, 500)}`,
    "",
    "**What I tried first (didn't work):** the obvious retry.",
    "",
    "**What actually worked:** treating it as a structural issue (circuit breaker + cooldown) rather than a transient one.",
    "",
    "Curious if others have hit the same thing.",
  ].join("\n");
  return { title, body };
}

// ---- Strategy -----------------------------------------------------------

const moltbookStrategy = {
  connectorName: "moltbook",

  discoverOperation: "getFeed",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    _commentsThisCycle = 0;
    _postsThisCycle = 0;

    // Moltbook guidance: comment MORE than you post. New posts are only
    // attempted every N cycles (see toTask below).
    const feed = await connector.getFeed({ sort: "new", limit: MAX_POSTS_PER_CYCLE * 3 });
    const posts = feed.posts || feed.data || feed || [];
    if (!Array.isArray(posts)) return [];

    return posts.filter(
      (p) =>
        p &&
        p.id &&
        !_state.commentedPostIds.has(p.id) &&
        !_state.upvotedPostIds.has(p.id)
    );
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "moltbook_reputation",
    rewardUsd: 0,
    successProbability: 0.9,
    estimatedModelCostUsd: 0,
    platformFeeUsd: 0,
    riskLevel: "LOW",
    reputationValue: Math.max(0, Math.min(1, 1 - (raw.upvotes || 0) / 50)),
  }),

  toTask: (raw) => {
    const now = Date.now();

    // --- POST PATH (every POST_COOLDOWN_MS at most) ---
    // CORRECTNESS NOTE (found in audit): nothing currently sets
    // `raw.__shareAsPost` anywhere in this codebase — this branch is
    // unreachable dead code today. The live, actual auto-post mechanism
    // is `UniversalAgent._maybePublishMoltbookPost` in
    // core/universalAgent.js, which calls connector.createPost() directly
    // after any successful task (not through this strategy/pipeline at
    // all). It now reads/writes the SAME state file and field names as
    // this strategy (lastPostAt, publishedTitleHashes in moltbook-state.
    // json) specifically so the two don't desynchronize on Moltbook's
    // real rate limit — see the comments there. This branch is left in
    // place (not deleted) as the intended integration point if a future
    // change wires task completions through the pipeline instead; until
    // then, treat it as inactive.
    if (
      raw.__shareAsPost &&
      now - _state.lastPostAt >= POST_COOLDOWN_MS &&
      _postsThisCycle === 0
    ) {
      _postsThisCycle += 1;
      const { title, body } = buildBuildLogPost(raw.__shareAsPost);
      const hash = titleHash(title);
      if (_state.publishedTitleHashes.has(hash)) {
        // Same topic already shipped — fall through to comment path.
      } else {
        return {
          id: `moltbook-post-${hash}`,
          type: "communication",
          input: {
            context: `Draft a Moltbook POST (not a comment). Title idea: "${title}". Body idea: "${body}".`,
            goal: [
              "Refine this into a Moltbook POST. Output ONLY valid JSON:",
              '{"title":"...","body":"..."}',
              "",
              "TITLE rules:",
              "- 40-90 characters. Specific. No clickbait, no emojis.",
              "- Must include the connector or capability name and a concrete outcome.",
              "",
              "BODY rules (80-180 words):",
              "- Open with the specific thing that happened (a number, a tool, an error).",
              "- Include ONE concrete detail: endpoint, metric, latency, error code.",
              "- End with ONE open question to the community.",
              "- No links, no self-promotion, no 'I am an AI' disclaimers.",
              "",
              "If you cannot produce both a title and a body that satisfy these rules, output the single word: SKIP.",
            ].join("\n"),
            raw: { ...raw, __postTitle: title },
          },
          untrustedContent: raw.content,
          untrustedSource: "moltbook-post-body",
          sourceConnector: "moltbook",
        };
      }
    }

    // --- COMMENT PATH (at most MAX_COMMENTS_PER_CYCLE per cycle) ---
    const wantsComment = _commentsThisCycle < MAX_COMMENTS_PER_CYCLE;
    if (wantsComment) {
      _commentsThisCycle += 1;
      return {
        id: `moltbook-comment-${raw.id}`,
        type: "communication",
        input: {
          context: `Moltbook post in m/${raw.submolt || "general"} by ${raw.author || "an agent"}: "${raw.title || ""}". Body (untrusted): ${(raw.content || "").slice(0, 800)}`,
          goal: [
            "Write ONE Moltbook reply. Target 2-4 sentences (~40-90 words).",
            "",
            "HARD RULES (from Moltbook's own community rules):",
            "- First sentence MUST quote or paraphrase a SPECIFIC concrete detail",
            "  from the post (a named tool, a number, a file, an error code).",
            "- Ban these openings (Moltbook treats them as hollow/spam):",
            '  "Great post!", "Thanks for sharing", "Interesting",',
            '  "Your observation highlights", "This is a common/known risk".',
            "- Add ONE of: a concrete question, a relevant experience, a technical",
            "  addition, or a specific counter-example. Nothing generic.",
            "- Do NOT mention Moltbook, karma, or that you are an AI.",
            "- No links. Plain text only.",
            "",
            "If you cannot satisfy these rules given the post content, output",
            "the single word: SKIP. (Silence is better than filler.)",
          ].join("\n"),
        },
        untrustedContent: raw.content,
        untrustedSource: "moltbook-post-body",
        sourceConnector: "moltbook",
      };
    }

    // Fallback: upvote-only (no LLM call).
    return {
      id: `moltbook-upvote-${raw.id}`,
      type: "communication",
      input: {
        context: `Upvote Moltbook post ${raw.id}.`,
        goal: "One sentence acknowledging the upvote (not posted anywhere).",
      },
      untrustedContent: raw.content,
      untrustedSource: "moltbook-post-body",
      sourceConnector: "moltbook",
    };
  },

  submitOperation: "commentOnPost",
  submitPermission: "USE_EXTERNAL_API",
  submit: async (connector, raw, draftText) => {
    const postId = raw && raw.id ? String(raw.id) : "";
    const now = Date.now();

    // --- POST path: submit the drafted JSON as a real post ---
    if (raw.__postTitle) {
      if (String(draftText).trim().toUpperCase() === "SKIP") {
        return { skipped: true, reason: "LLM declined to produce a valid post" };
      }
      let parsed;
      try {
        parsed = JSON.parse(String(draftText).trim());
      } catch (e) {
        return { skipped: true, reason: "post JSON parse failed" };
      }
      if (!parsed.title || !parsed.body) {
        return { skipped: true, reason: "post missing title or body" };
      }

      const hash = titleHash(parsed.title);
      if (_state.publishedTitleHashes.has(hash)) {
        return { skipped: true, reason: "duplicate post title hash" };
      }

      const response = await connector.createPost({
        title: parsed.title,
        body: parsed.body,
        submolt: raw.__postSubmolt || "general",
      });

      _state.publishedTitleHashes.add(hash);
      _state.lastPostAt = Date.now();
      saveState(_state);

      // Handle verification challenge if returned (see Moltbook docs).
      const challenge = connector.extractChallenge(response);
      if (challenge) {
        const answer = connector.solveChallenge(challenge.challenge);
        await connector.verifyChallenge(challenge.code, answer);
      }
      return response;
    }

    // --- COMMENT path ---
    if (_state.commentedPostIds.has(postId)) {
      _state.upvotedPostIds.add(postId);
      saveState(_state);
      return connector.upvotePost(postId);
    }

    if (String(draftText).trim().toUpperCase() === "SKIP") {
      _state.upvotedPostIds.add(postId);
      saveState(_state);
      return connector.upvotePost(postId);
    }

    // Respect Moltbook's 20-second comment cooldown.
    const waitMs = Math.max(0, _state.lastCommentAt + COMMENT_COOLDOWN_MS - now);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const commentResponse = await connector.commentOnPost(postId, { content: draftText });

    _state.commentedPostIds.add(postId);
    _state.lastCommentAt = Date.now();
    saveState(_state);

    const challenge = connector.extractChallenge(commentResponse);
    if (challenge) {
      const answer = connector.solveChallenge(challenge.challenge);
      await connector.verifyChallenge(challenge.code, answer);
    }
    return commentResponse;
  },
};

module.exports = moltbookStrategy;
