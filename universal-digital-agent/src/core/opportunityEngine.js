"use strict";

/**
 * Opportunity Discovery Engine (spec section 12). Purely deterministic
 * arithmetic over normalized opportunity records — no LLM call needed here.
 *
 *   EXPECTED VALUE = REWARD * SUCCESS_PROBABILITY - TOTAL_COST
 */

/**
 * @param {object} scored - the strategy's `toOpportunity()` output (scoring
 *   fields only: rewardUsd, successProbability, etc).
 * @param {string} sourceConnector
 * @param {object} [originalRaw] - the actual discovered listing (title,
 *   description, budget field, repository_url, number, ...) as returned by
 *   the connector's discover call. BUG FIX: this used to default to `scored`
 *   itself when the caller didn't pass a third argument, which is exactly
 *   what marketplacePipeline.js's only call site was doing — meaning
 *   `opportunity.raw` was silently the scoring summary, not the real
 *   listing, so every strategy's `toTask(opportunity.raw)` and
 *   `submit(connector, opportunity.raw, ...)` downstream lost the listing's
 *   title/description/budget/repository_url/number fields entirely. Now an
 *   explicit `originalRaw` is required by the one real caller; the old
 *   fallback is kept only so nothing else depending on the 2-arg shape
 *   breaks.
 */
function normalizeOpportunity(scored, sourceConnector, originalRaw) {
  return {
    id: scored.id,
    sourceConnector,
    type: scored.type,
    rewardUsd: scored.rewardUsd ?? null,
    estimatedEffortMinutes: scored.estimatedEffortMinutes ?? null,
    estimatedTokens: scored.estimatedTokens ?? null,
    estimatedModelCostUsd: scored.estimatedModelCostUsd ?? 0,
    platformFeeUsd: scored.platformFeeUsd ?? 0,
    successProbability: scored.successProbability ?? 0.5,
    estimatedCompletionMinutes: scored.estimatedCompletionMinutes ?? scored.estimatedEffortMinutes ?? null,
    riskLevel: scored.riskLevel || "MEDIUM",
    reputationValue: scored.reputationValue ?? 0,
    // Explicitly distinguishes "this listing has a known reward of $0" from
    // "this listing's reward is unknown/missing" (rewardUsd null). Without
    // this, a listing with no usable budget field scores expectedValue ~= 0,
    // which used to pass a minExpectedValue of 0 and get ACCEPTED — meaning
    // a real LLM call drafted a full proposal for it, only for submit() to
    // then discover it can't actually be bid on ("no usable budget in the
    // listing") and throw the draft away. Every cycle, forever, for the
    // same recurring listing. See rankOpportunities below.
    hasKnownReward: scored.rewardUsd != null,
    // IMPORTANT: `raw` is the ORIGINAL discovered listing (with title/body/
    // repository_url/number/budget field/etc), not the scoring summary.
    // If the caller forgot to pass originalRaw, we fall back to `scored` so
    // existing 2-arg callers don't crash — but every real caller in
    // marketplacePipeline.js must pass the third argument.
    raw: originalRaw !== undefined ? originalRaw : scored,
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

  // A listing whose reward is unknown (as opposed to a known low/zero
  // value) is rejected regardless of minExpectedValue — see
  // normalizeOpportunity's hasKnownReward comment above.
  const accepted = scored.filter((o) => o.hasKnownReward !== false && o.expectedValue >= minExpectedValue);
  const rejected = scored
    .filter((o) => o.hasKnownReward === false || o.expectedValue < minExpectedValue)
    .map((o) => ({ ...o, rejectionReason: o.hasKnownReward === false ? "insufficient_listing_data" : "low_expected_value" }));

  return { accepted, rejected };
}

module.exports = { normalizeOpportunity, expectedValue, totalCost, rankOpportunities };
