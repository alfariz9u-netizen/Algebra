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
 */
function rankOpportunities(opportunities, { minExpectedValue = 0 } = {}) {
  const scored = opportunities.map((o) => ({ ...o, expectedValue: expectedValue(o), totalCost: totalCost(o) }));
  scored.sort((a, b) => b.expectedValue - a.expectedValue);

  const accepted = scored.filter((o) => o.expectedValue >= minExpectedValue);
  const rejected = scored.filter((o) => o.expectedValue < minExpectedValue);

  return { accepted, rejected };
}

module.exports = { normalizeOpportunity, expectedValue, totalCost, rankOpportunities };
