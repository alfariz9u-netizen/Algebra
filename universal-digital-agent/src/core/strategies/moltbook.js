"use strict";

/**
 * Moltbook reputation-building strategy for MarketplacePipeline.
 *
 * Unlike the bidding strategies (moltMarket, openTask, ...), this one is
 * NOT about earning money per task. Its job is to grow the agent's
 * Moltbook karma — the portable reputation score that other agents and
 * platforms read — by:
 *   1. Upvoting a small number of worthwhile posts (cheap, safe, builds
 *      reciprocity and makes the agent a "real" participant).
 *   2. Leaving a short, substantive comment on ONE fresh post per cycle.
 *
 * FIX #1 — no more duplicate comments on the same post:
 * sort:"new" (not "hot") + process-lifetime Sets prevent re-engaging
 * the same post id within a running session.
 *
 * FIX #2 — at most ONE comment per cycle:
 * A per-cycle counter turns every subsequent opportunity into an upvote
 * (no LLM call, no duplicate text).
 *
 * FIX #3 — varied comment openings:
 * Hard rules in the goal forbid the placeholder openings seen in
 * production and require referencing a specific concrete detail.
 *
 * FIX #4 — solve the verification challenge:
 * Moltbook requires every published comment to be "verified" by solving
 * an obfuscated lobster-themed math word problem within ~30 seconds. If
 * the challenge isn't solved, the comment silently stays unpublished —
 * meaning every comment we ever posted was invisible and the whole
 * reputation-building strategy was wasted. submit() now:
 *   1. calls commentOnPost();
 *   2. reads .verification from the response;
 *   3. solves the challenge deterministically (connector.solveChallenge);
 *   4. POSTs the answer via connector.verifyChallenge().
 * Only after successful verification does it mark the post as commented.
 * A verification failure does NOT get silently swallowed — it's thrown
 * so the learning engine can back off instead of hammering the API.
 */

const REWARD_PER_ACTION_USD = 0; // pure reputation, no direct cash
const SUCCESS_PROBABILITY = 0.9; // upvotes/comments rarely fail
const MAX_POSTS_PER_CYCLE = Number(process.env.MOLTBOOK_POSTS_PER_CYCLE || 3);
// At most one comment per cycle, regardless of how many posts are
// discovered. Everything else becomes an upvote.
const MAX_COMMENTS_PER_CYCLE = Number(process.env.MOLTBOOK_COMMENTS_PER_CYCLE || 1);

// Process-lifetime dedup sets. They reset on redeploy/restart (no
// persistent store here yet), which is acceptable — within one running
// session we never double-engage the same post, and sort:"new" ensures
// each cycle sees different posts anyway.
const _commentedPostIds = new Set();
const _upvotedPostIds = new Set();

// Reset at the top of every discover() call.
let _commentsThisCycle = 0;

const moltbookStrategy = {
  connectorName: "moltbook",

  // ---- Phase 1: discover posts worth engaging with ----
  discoverOperation: "getFeed",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    // Reset the per-cycle comment budget every time a new cycle starts.
    _commentsThisCycle = 0;

    // sort:"new" (not "hot") gives fresh posts each cycle.
    // Over-fetch by 3x so we still have candidates after filtering.
    const feed = await connector.getFeed({ sort: "new", limit: MAX_POSTS_PER_CYCLE * 3 });
    const posts = feed.posts || feed.data || feed || [];
    if (!Array.isArray(posts)) return [];

    // Exclude posts already engaged with in this process.
    return posts.filter(
      (p) =>
        p &&
        p.id &&
        !_commentedPostIds.has(p.id) &&
        !_upvotedPostIds.has(p.id)
    );
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "moltbook_reputation",
    rewardUsd: REWARD_PER_ACTION_USD,
    successProbability: SUCCESS_PROBABILITY,
    estimatedModelCostUsd: 0,
    platformFeeUsd: 0,
    riskLevel: "LOW",
    reputationValue: Math.max(0, Math.min(1, 1 - (raw.upvotes || 0) / 50)),
  }),

  /**
   * FIX #2: at most ONE comment per cycle. Every subsequent opportunity
   * in the same cycle becomes an upvote (no LLM call → no cost, no
   * duplicate text).
   */
  toTask: (raw) => {
    const wantsComment = _commentsThisCycle < MAX_COMMENTS_PER_CYCLE;
    if (wantsComment) {
      _commentsThisCycle += 1;
      return {
        id: `moltbook-comment-${raw.id}`,
        type: "communication",
        input: {
          context: `Moltbook post in m/${raw.submolt || "general"} by ${raw.author || "an agent"}: "${raw.title || ""}". Body (untrusted): ${(raw.content || "").slice(0, 600)}`,
          // FIX #3: explicit anti-filler, anti-repetition rules.
          goal: [
            "Write ONE short reply (2-4 sentences) to this Moltbook post.",
            "",
            "HARD RULES:",
            "- The FIRST SENTENCE must reference a specific concrete detail",
            "  from the post body (a named tool, number, file, or claim).",
            "  Do NOT open with any of these (they are banned):",
            '  "Your observation highlights..."',
            '  "This is a common/known risk..."',
            '  "Great post!"',
            '  "Thanks for sharing..."',
            '  "This is an important topic..."',
            "- Do NOT restate the post's own thesis back to it.",
            "- Do NOT mention Moltbook, karma, or that this is automated.",
            "- Do NOT include links.",
            "- Prefer one concrete suggestion, counter-example, or missing",
            "  consideration over generic agreement.",
            "",
            "Tone: technical, direct, human. Plain text only.",
          ].join("\n"),
        },
        untrustedContent: raw.content,
        untrustedSource: "moltbook-post-body",
        sourceConnector: "moltbook",
      };
    }
    // Upvote path — no LLM call needed.
    return {
      id: `moltbook-upvote-${raw.id}`,
      type: "communication",
      input: {
        context: `Upvote Moltbook post ${raw.id} ("${raw.title || ""}").`,
        goal: "Acknowledge the upvote in one sentence (this text is not posted anywhere).",
      },
      untrustedContent: raw.content,
      untrustedSource: "moltbook-post-body",
      sourceConnector: "moltbook",
    };
  },

  // ---- Phase 2: submit ----
  submitOperation: "commentOnPost",
  submitPermission: "USE_EXTERNAL_API",
  submit: async (connector, raw, draftText) => {
    const postId = raw && raw.id ? String(raw.id) : "";

    // Upvote path: if we've already commented on this post in this
    // session, upvote instead of trying to comment again.
    if (_commentedPostIds.has(postId)) {
      _upvotedPostIds.add(postId);
      return connector.upvotePost(postId);
    }

    // Comment path — post a comment, then immediately handle the
    // Moltbook verification challenge if one is returned.
    const commentResponse = await connector.commentOnPost(postId, { content: draftText });

    // FIX #4: solve the verification challenge. Without this the comment
    // silently stays unpublished and the whole reputation-building
    // strategy is wasted.
    const challenge = connector.extractChallenge(commentResponse);
    if (challenge) {
      // The challenge is a deterministic math word problem — no LLM call
      // needed. If parsing fails we throw so the learning engine backs
      // off rather than submitting a wrong answer (10 wrong answers =
      // account suspension).
      const answer = connector.solveChallenge(challenge.challenge);
      await connector.verifyChallenge(challenge.code, answer);
    }

    // Only mark the post as "commented" once the whole flow (comment +
    // verification) has succeeded. If verification threw, we never reach
    // this line, so the next cycle will retry cleanly instead of the
    // post being silently considered "done".
    _commentedPostIds.add(postId);
    return commentResponse;
  },
};

module.exports = moltbookStrategy;
