"use strict";

/**
 * Moltbook reputation-building strategy for MarketplacePipeline.
 *
 * FIX #1 — no more duplicate comments on the same post (sort:"new" + Sets).
 * FIX #2 — at most ONE comment per cycle.
 * FIX #3 — varied comment openings (banned phrases).
 * FIX #4 — solve the Moltbook verification challenge:
 *   Every published comment must be verified by solving an obfuscated
 *   math word problem within ~30s, otherwise the comment stays invisible.
 *   submit() now: commentOnPost → extractChallenge → solveChallenge →
 *   verifyChallenge. Without this, karma stayed at 0 forever.
 */

const REWARD_PER_ACTION_USD = 0;
const SUCCESS_PROBABILITY = 0.9;
const MAX_POSTS_PER_CYCLE = Number(process.env.MOLTBOOK_POSTS_PER_CYCLE || 3);
const MAX_COMMENTS_PER_CYCLE = Number(process.env.MOLTBOOK_COMMENTS_PER_CYCLE || 1);

const _commentedPostIds = new Set();
const _upvotedPostIds = new Set();

let _commentsThisCycle = 0;

const moltbookStrategy = {
  connectorName: "moltbook",

  discoverOperation: "getFeed",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    _commentsThisCycle = 0;

    const feed = await connector.getFeed({ sort: "new", limit: MAX_POSTS_PER_CYCLE * 3 });
    const posts = feed.posts || feed.data || feed || [];
    if (!Array.isArray(posts)) return [];

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

  toTask: (raw) => {
    const wantsComment = _commentsThisCycle < MAX_COMMENTS_PER_CYCLE;
    if (wantsComment) {
      _commentsThisCycle += 1;
      return {
        id: `moltbook-comment-${raw.id}`,
        type: "communication",
        input: {
          context: `Moltbook post in m/${raw.submolt || "general"} by ${raw.author || "an agent"}: "${raw.title || ""}". Body (untrusted): ${(raw.content || "").slice(0, 600)}`,
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

  submitOperation: "commentOnPost",
  submitPermission: "USE_EXTERNAL_API",
  submit: async (connector, raw, draftText) => {
    const postId = raw && raw.id ? String(raw.id) : "";

    if (_commentedPostIds.has(postId)) {
      _upvotedPostIds.add(postId);
      return connector.upvotePost(postId);
    }

    const commentResponse = await connector.commentOnPost(postId, { content: draftText });

    const challenge = connector.extractChallenge(commentResponse);
    if (challenge) {
      const answer = connector.solveChallenge(challenge.challenge);
      await connector.verifyChallenge(challenge.code, answer);
    }

    _commentedPostIds.add(postId);
    return commentResponse;
  },
};

module.exports = moltbookStrategy;
