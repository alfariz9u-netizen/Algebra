"use strict";

/**
 * AgentMarket strategy for MarketplacePipeline.
 *
 * Budgets on this platform are in CREDITS, not USD (1 credit = $0.01),
 * so rewardUsd converts explicitly — getting this wrong would make every
 * opportunity look 100x more valuable than it is.
 *
 * BUDGET-FIELD FIX: live production logs showed the connector returning
 * listings where `raw.budget` was undefined AND none of the previous
 * fallbacks (`price`/`reward`/`max_budget`) were present either — meaning
 * the actual field name for the reward is different again. Rather than
 * guess a single alternative, this version:
 *   1. Scans a much wider alias list (budget, budgetAmount, budgetCredits,
 *      price, reward, amount, credits, max_budget, maxBudget, value,
 *      payout, prize).
 *   2. When it still can't find a numeric value, logs the actual top-level
 *      keys present in `raw` (one line, capped) so the next cycle's log
 *      tells us the real field name without needing to re-instrument.
 *   3. Rejects the opportunity at toOpportunity() time (rewardUsd=0, so
 *      rankOpportunities filters it out) instead of letting it through,
 *      paying for an LLM-drafted proposal, then failing at submit time —
 *      the exact cycle that kept repeating for task
 *      2542f7d6-d36a-49cd-ad33-0b1e05bbbd1b.
 */

function findBudgetCredits(raw) {
  const aliases = [
    "budget",
    "budgetAmount",
    "budget_amount",
    "budgetCredits",
    "budget_credits",
    "price",
    "reward",
    "rewardAmount",
    "reward_amount",
    "amount",
    "credits",
    "max_budget",
    "maxBudget",
    "value",
    "payout",
    "prize",
  ];
  for (const key of aliases) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** One-line dump of the top-level keys present in raw, for diagnostics. */
function describeRawKeys(raw) {
  if (!raw || typeof raw !== "object") return "(raw is not an object)";
  return Object.keys(raw).slice(0, 30).join(", ");
}

const agentMarketStrategy = {
  connectorName: "agentMarket",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => connector.discoverTasks({ status: "open" }),

  toOpportunity: (raw) => {
    const credits = findBudgetCredits(raw);
    if (credits === null) {
      // Log ONCE per listing per process-lifetime — the Set is keyed by
      // task id so it only prints the first time we see this specific
      // layout, not on every cycle.
      if (!_loggedMissingBudgetIds.has(raw.id)) {
        _loggedMissingBudgetIds.add(raw.id);
        console.warn(
          `[agentMarket] No budget field found for task ${raw.id} "${String(raw.title || "").slice(0, 60)}". ` +
            `Available keys: [${describeRawKeys(raw)}]. ` +
            `Add the real field name to findBudgetCredits()'s alias list.`
        );
      }
    }
    return {
      id: raw.id,
      type: "agentmarket_task",
      // No budget ⇒ rewardUsd=0 ⇒ rankOpportunities rejects it as
      // "low_expected_value" BEFORE an LLM call drafts a proposal for it.
      rewardUsd: credits !== null ? credits * 0.01 : 0,
      successProbability: Number(process.env.AGENTMARKET_DEFAULT_BID_WIN_RATE || 0.4),
      estimatedModelCostUsd: 0,
      platformFeeUsd: 0,
      riskLevel: "MEDIUM",
    };
  },

  toTask: (raw) => {
    const credits = findBudgetCredits(raw);
    return {
      id: `agentmarket-bid-${raw.id}`,
      type: "communication",
      input: {
        context: `Open task on AgentMarket — Title: "${raw.title}". Description: ${raw.description || "n/a"}. Budget: ${credits != null ? `${credits} credits ($${(credits * 0.01).toFixed(2)})` : "unspecified"}.`,
        goal:
          "Draft a concise, professional bid pitch for this task, explaining your approach and why you're a good fit.",
        raw,
      },
      untrustedContent: raw.description,
      untrustedSource: "agentmarket-listing",
      sourceConnector: "agentMarket",
    };
  },

  submitOperation: "bidOnTask",
  submitPermission: "SUBMIT_TASK",
  submit: (connector, raw, proposalText) => {
    const credits = findBudgetCredits(raw);
    if (credits === null) {
      throw new Error(
        `Skipping bid on task ${raw.id}: no usable budget found in the listing. ` +
          `Available keys: [${describeRawKeys(raw)}].`
      );
    }
    return connector.bidOnTask(raw.id, { bidAmount: credits, message: proposalText });
  },
};

// Process-lifetime set — prevents the same diagnostic from spamming the
// logs on every 30-minute cycle for the same recurring broken listing.
const _loggedMissingBudgetIds = new Set();

module.exports = agentMarketStrategy;
