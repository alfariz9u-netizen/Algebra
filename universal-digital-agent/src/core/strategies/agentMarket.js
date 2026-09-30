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
 * fallbacks (`price`/`reward`/`max_budget`) were present either. This
 * version scans a much wider alias list (budget, budgetAmount,
 * budgetCredits, price, reward, amount, credits, max_budget, maxBudget,
 * value, payout, prize), logs the actual top-level keys when none match,
 * and rejects the opportunity at toOpportunity() time (rewardUsd=0, so
 * rankOpportunities filters it out) instead of paying for an LLM-drafted
 * proposal that would then fail at submit time.
 *
 * 409 "ALREADY BID" FIX: AgentMarket returns
 *   409 {"success":false,"error":"You have already bid on this task"}
 * when the agent has an active bid on the task from a previous cycle.
 * This is NOT a failure — our bid is still pending — but the old submit()
 * treated it as one, which:
 *   1. recorded a task_failed in economics,
 *   2. marked the opportunity dead in LearningEngine,
 *   3. and (because there's no circuit breaker reset) kept the task
 *      looking "broken" for the next 30 minutes.
 * Now submit() recognizes the 409-already-bid response and returns it as
 * a successful submission, so the pipeline records task_completed and
 * moves on. _attemptedTaskIds prevents re-bidding on the same task
 * within a single process lifetime anyway.
 */

const MIN_BUDGET_CREDITS = Number(process.env.AGENTMARKET_MIN_BUDGET_CREDITS || 1);

// Process-lifetime dedupe: once we've bid on (or been told we already
// bid on) a task, don't draft another proposal for it in this session.
const _attemptedTaskIds = new Set();

// Process-lifetime set — prevents the same diagnostic from spamming the
// logs on every 30-minute cycle for the same recurring broken listing.
const _loggedMissingBudgetIds = new Set();

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

/** True when the error is AgentMarket's "you already have an active bid" 409. */
function isAlreadyBidError(err) {
  const msg = String((err && err.message) || "").toLowerCase();
  return (
    msg.includes("409") &&
    (msg.includes("already bid") ||
      msg.includes("already have bid") ||
      msg.includes("you have already bid") ||
      msg.includes("already have an active bid"))
  );
}

const agentMarketStrategy = {
  connectorName: "agentMarket",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const tasks = await connector.discoverTasks({ status: "open" });
    const list = Array.isArray(tasks) ? tasks : tasks.data || [];
    return list.filter((t) => t && t.id && !_attemptedTaskIds.has(t.id));
  },

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
  submit: async (connector, raw, proposalText) => {
    const credits = findBudgetCredits(raw);
    if (credits === null || credits < MIN_BUDGET_CREDITS) {
      _attemptedTaskIds.add(raw.id);
      throw new Error(
        `Skipping bid on task ${raw.id}: no usable budget found in the listing. ` +
          `Available keys: [${describeRawKeys(raw)}].`
      );
    }

    try {
      const result = await connector.bidOnTask(raw.id, {
        bidAmount: credits,
        message: proposalText,
      });
      _attemptedTaskIds.add(raw.id);
      return result;
    } catch (err) {
      // FIX: 409 "You have already bid on this task" is NOT a failure —
      // our previous bid is still active on the platform. Treat it as a
      // successful submission so:
      //   1. the pipeline records task_completed (not task_failed),
      //   2. the economics summary stays accurate,
      //   3. LearningEngine's dead-opportunity memory doesn't mark the
      //      task as broken.
      // _attemptedTaskIds also ensures we don't re-draft a proposal for
      // the same task within this session.
      if (isAlreadyBidError(err)) {
        _attemptedTaskIds.add(raw.id);
        return {
          alreadyBid: true,
          taskId: raw.id,
          message: "Existing active bid confirmed (409 already-bid treated as success).",
        };
      }
      // FIX: this used to add raw.id to _attemptedTaskIds here too, which
      // permanently excludes the task from discovery for the rest of the
      // process's lifetime — even for a purely transient failure (a
      // network blip, a 500). That's strictly worse than doing nothing:
      // learningEngine's circuit breaker (in marketplacePipeline.js)
      // already classifies retryable vs. non-retryable failures properly
      // and backs off accordingly; this blunt, permanent, un-logged
      // exclusion silently overrode that for every non-409 error and
      // could mean a still-open, still-biddable task is never looked at
      // again this session. Only the two cases above (no usable budget;
      // confirmed already-bid) are genuinely permanent for this task, so
      // only those two add to _attemptedTaskIds. Anything else is
      // rethrown and left to the pipeline's own retry/backoff logic.
      throw err;
    }
  },
};

module.exports = agentMarketStrategy;
