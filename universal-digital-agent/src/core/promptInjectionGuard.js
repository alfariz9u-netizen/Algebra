"use strict";

/**
 * Opportunity Discovery Engine (spec section 12). Purely deterministic
 * arithmetic over normalized opportunity records — no LLM call needed here.
 *
 *   EXPECTED VALUE = REWARD * SUCCESS_PROBABILITY - TOTAL_COST
 */

function normalizeOpportunity(raw, sourceConnector) {
  return {
    id: raw.id,
    sourceConnector,
    type: raw.type,
    rewardUsd: raw.rewardUsd ?? null,
    estimatedEffortMinutes: raw.estimatedEffortMinutes ?? null,
    estimatedTokens: raw.estimatedTokens ?? null,
    estimatedModelCostUsd: raw.estimatedModelCostUsd ?? 0,
    platformFeeUsd: raw.platformFeeUsd ?? 0,
    successProbability: raw.successProbability ?? 0.5,
    estimatedCompletionMinutes: raw.estimatedCompletionMinutes ?? raw.estimatedEffortMinutes ?? null,
    riskLevel: raw.riskLevel || "MEDIUM",
    reputationValue: raw.reputationValue ?? 0,
    // Explicitly distinguishes "this listing has a known reward of $0" from
    // "this listing's reward is unknown/missing" (rewardUsd null). The two
    // used to be treated identically (both score expectedValue ~= 0 and
    // could pass a minExpectedValue of 0), which meant a listing with no
    // usable budget field would get accepted, drafted via a real LLM call,
    // and only THEN discovered to be unbiddable at submit time — every
    // single cycle, forever, for the same recurring listing. See
    // rankOpportunities below.
    hasKnownReward: raw.rewardUsd != null,
    raw,
  };
}

function totalCost(opportunity) {
  return (opportunity.estimatedModelCostUsd || 0) + (opportunity.platformFeeUsd || 0);
}

function expectedValue(opportunity) {
  const reward = opportunity.rewardUsd || 0;
  return reward * opportunity.successProbability - totalCost(opportunity);
}

/**
 * Ranks and filters opportunities. Opportunities with a negative expected
 * value are rejected by default (spec: "should normally reject opportunities
 * with poor expected value"), but always returned in `rejected` for
 * visibility rather than silently dropped.
 *
 * A listing whose reward is unknown (`hasKnownReward: false`) is ALSO
 * rejected regardless of `minExpectedValue`, tagged
 * `rejectionReason: "insufficient_listing_data"` — accepting it would mean
 * spending a real LLM call drafting a proposal for a job that is
 * structurally impossible to bid on, only to discover that at submit time.
 * Every other rejection is tagged `"low_expected_value"`.
 */
function rankOpportunities(opportunities, { minExpectedValue = 0 } = {}) {
  const scored = opportunities.map((o) => ({ ...o, expectedValue: expectedValue(o), totalCost: totalCost(o) }));
  scored.sort((a, b) => b.expectedValue - a.expectedValue);

  const accepted = scored.filter((o) => o.hasKnownReward !== false && o.expectedValue >= minExpectedValue);
  const rejected = scored
    .filter((o) => o.hasKnownReward === false || o.expectedValue < minExpectedValue)
    .map((o) => ({ ...o, rejectionReason: o.hasKnownReward === false ? "insufficient_listing_data" : "low_expected_value" }));

  return { accepted, rejected };
}

module.exports = { normalizeOpportunity, expectedValue, totalCost, rankOpportunities };
