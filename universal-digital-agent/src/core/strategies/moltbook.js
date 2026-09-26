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
 *   2. Leaving a short, substantive comment on one post whose topic
 *      matches one of the agent's real capabilities.
 *
 * It deliberately does NOT post new content here (separate capability),
 * and does NOT run the verification challenge solver (separate concern).
 * Both are easy to add later.
 *
 * Reward is modeled as reputationValue, not rewardUsd — so this cycle
 * should run with minExpectedValue: -1 (i.e. "always accepted") while it
 * is purely reputation-building. Once karma is high enough that Moltbook
 * interactions can be monetized (e.g. sponsored posts, paid communities),
 * the same strategy can be extended with a real rewardUsd.
 */

const REWARD_PER_ACTION_USD = 0; // pure reputation, no direct cash
const SUCCESS_PROBABILITY = 0.9; // upvotes/comments rarely fail
const MAX_POSTS_PER_CYCLE = Number(process.env.MOLTBOOK_POSTS_PER_CYCLE || 3);

const moltbookStrategy = {
  connectorName: "moltbook",

  // ---- Phase 1: discover posts worth engaging with ----
  discoverOperation: "getFeed",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    // "hot" surfaces the posts most likely to still be active. We only
    // need a handful — this is not a volume play.
    const feed = await connector.getFeed({ sort: "hot", limit: MAX_POSTS_PER_CYCLE });
    const posts = feed.posts || feed.data || feed || [];
    return Array.isArray(posts) ? posts : [];
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "moltbook_reputation",
    // No cash reward — ranked purely by reputationValue below.
    rewardUsd: REWARD_PER_ACTION_USD,
    successProbability: SUCCESS_PROBABILITY,
    estimatedModelCostUsd: 0, // the upvote path costs nothing; the comment path costs one LLM call
    platformFeeUsd: 0,
    riskLevel: "LOW",
    // Cheap heuristic: newer, less-engaged posts benefit most from an
    // upvote/comment, and are more likely to trigger a reciprocal follow.
    // Bounded 0..1 so it plays nicely with rankOpportunities' expectedValue.
    reputationValue: Math.max(0, Math.min(1, 1 - (raw.upvotes || 0) / 50)),
  }),

  /**
   * Route each opportunity to either:
   *   - upvotePost (deterministic, no LLM, permission SUBMIT_TASK is heavy
   *     for this — we use USE_EXTERNAL_API which matches "write to an
   *     external service" and is LOW risk at autonomy>=2), or
   *   - commentOnPost (drafts the comment via the `communication`
   *     capability, same pattern as moltMarket's bid drafting).
   *
   * Alternates: the first opportunity of each cycle becomes a comment
   * (higher value, higher effort), the rest are upvotes (cheap karma).
   */
  toTask: (raw, _opportunity, index = 0) => {
    if (index === 0) {
      // Comment path — goes through the LLM via the `communication` capability.
      return {
        id: `moltbook-comment-${raw.id}`,
        type: "communication",
        input: {
          context: `Moltbook post in m/${raw.submolt || "general"} by ${raw.author || "an agent"}: "${raw.title || ""}". Body (untrusted): ${(raw.content || "").slice(0, 600)}`,
          goal:
            "Draft ONE short (2-4 sentence) reply to this Moltbook post as a professional AI agent. Add a concrete, checkable point — no filler, no flattery, no links. Do not mention this is an automated comment.",
        },
        untrustedContent: raw.content,
        untrustedSource: "moltbook-post-body",
        sourceConnector: "moltbook",
      };
    }
    // Upvote path — no LLM call needed, the "task" is just the vote itself.
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
  // Both actions use the same permission: writing to an external service.
  submitOperation: "commentOnPost",
  submitPermission: "USE_EXTERNAL_API",
  submit: async (connector, raw, draftText, { index = 0 } = {}) => {
    if (index === 0) {
      return connector.commentOnPost(raw.id, { content: draftText });
    }
    return connector.upvotePost(raw.id);
  },
};

module.exports = moltbookStrategy;
