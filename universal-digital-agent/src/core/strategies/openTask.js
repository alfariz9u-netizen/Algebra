"use strict";

/**
 * OpenTask.ai strategy for MarketplacePipeline. Same bid-first economic
 * logic as Molt Market: draft and submit a bid/proposal on an open task
 * rather than producing the full deliverable before any commitment exists.
 *
 * HONESTY NOTE: built from OpenTask's documented high-level API surface
 * (see connectors/openTask.js) using a conventional REST field-naming
 * guess (`reward_usd`, `title`, `description`) — not verified field-by-field
 * against a live account. toOpportunity/toTask below check several
 * plausible field-name spellings defensively rather than trust one guess,
 * the same lesson learned the hard way on AgentMarket ("budget") and
 * Molt Market ("budget_usdc" vs "budgetUsdc"). A live 401 on the actual
 * bid submission (despite discovery working with the same token) has also
 * been observed — the fix was route confusion: the write path is
 * /agent/tasks/{id}/bids (bearer route), NOT /tasks/{id}/bids (browser
 * route). See connectors/openTask.js for the corrected submitBid.
 */

const MIN_REWARD_USD = Number(process.env.OPENTASK_MIN_REWARD_USD || 1);
const BID_RATIO = Number(process.env.OPENTASK_BID_RATIO || 1.0); // 1.0 = bid the full listed reward
const DEFAULT_ETA_DAYS = Number(process.env.OPENTASK_DEFAULT_ETA_DAYS || 1);

// Session-lifetime de-dupe — avoids re-bidding the same still-open task
// every time /opentask is run (resets on redeploy; no cross-restart store
// exists yet).
const _attemptedTaskIds = new Set();

// Confirmed via /raw against a live account: OpenTask returns
// `budgetAmount` as a STRING (e.g. "9") plus `budgetCurrency: "USDC"` and
// a human `budgetText` like "9 USDC" — not `reward_usd`, which was a
// pre-verification guess that never matched. USDC is treated as ~1:1 USD
// here, same simplification already used for Molt Market/Molt Jobs.
function extractReward(raw) {
  if (typeof raw.budgetAmount === "string" || typeof raw.budgetAmount === "number") {
    const n = parseFloat(raw.budgetAmount);
    if (Number.isFinite(n)) return n;
  }
  if (typeof raw.budgetText === "string") {
    const m = raw.budgetText.match(/[\d.]+/);
    if (m) return parseFloat(m[0]);
  }
  // Older guesses, kept in case a different task shape ever shows up.
  const candidates = [raw.reward_usd, raw.rewardUsd, raw.budget_usd, raw.budgetUsd, raw.price_usd, raw.priceUsd, raw.amount_usd, raw.amountUsd];
  const found = candidates.find((v) => typeof v === "number");
  return typeof found === "number" ? found : null;
}

/** Bigger rewards on an open marketplace draw more competing bidders. */
function estimateWinRate(rewardUsd) {
  const base = Number(process.env.OPENTASK_DEFAULT_BID_WIN_RATE || 0.4);
  if (!(typeof rewardUsd === "number") || rewardUsd <= 0) return 0;
  if (rewardUsd >= 100) return Math.max(0.1, base - 0.25);
  if (rewardUsd >= 25) return Math.max(0.2, base - 0.1);
  return base;
}

const openTaskStrategy = {
  connectorName: "openTask",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const data = await connector.discoverTasks({ status: "open" });
    const tasks = Array.isArray(data) ? data : data.tasks || data.results || [];
    return tasks.filter((task) => task && task.id && !_attemptedTaskIds.has(task.id));
  },

  toOpportunity: (raw) => {
    const reward = extractReward(raw);
    const usable = typeof reward === "number" && reward >= MIN_REWARD_USD;
    return {
      id: raw.id,
      type: "opentask_task",
      rewardUsd: usable ? reward : 0,
      successProbability: usable ? estimateWinRate(reward) : 0,
      estimatedModelCostUsd: 0,
      platformFeeUsd: Number(process.env.OPENTASK_ESTIMATED_FEE_USD || 0),
      riskLevel: "MEDIUM",
    };
  },

  toTask: (raw) => ({
    id: `opentask-bid-${raw.id}`,
    type: "communication",
    input: {
      context: `Open task on OpenTask.ai — Title: "${raw.title}". Description: ${raw.description || raw.skillsTags?.join(", ") || "n/a"}. Budget: ${raw.budgetText || (extractReward(raw) != null ? `${extractReward(raw)} ${raw.budgetCurrency || "USDC"}` : "unspecified")}.`,
      goal: "Draft a concise, professional proposal for this task, explaining your approach and why you're a good fit.",
      raw, // preserved so the post-approval auto-submit step can rebuild the real bid
    },
    untrustedContent: raw.description || raw.title,
    untrustedSource: "opentask-listing",
    sourceConnector: "openTask",
  }),

  submitOperation: "submitBid",
  submitPermission: "SUBMIT_TASK",
  submit: async (connector, raw, proposalText) => {
    const reward = extractReward(raw);
    if (!(typeof reward === "number" && reward >= MIN_REWARD_USD)) {
      _attemptedTaskIds.add(raw.id); // permanently unusable listing — don't re-draft for it every cycle
      throw new Error(`Skipping bid on task ${raw.id}: no usable reward found (checked budgetAmount/budgetText/reward_usd, all missing or below the $${MIN_REWARD_USD} floor).`);
    }
    try {
      // The connector now expects the confirmed bearer-route schema:
      // priceText + etaDays + approach (see connectors/openTask.js, which
      // posts to /agent/tasks/{id}/bids — the browser route at
      // /tasks/{id}/bids always 401s for an API token).
      const result = await connector.submitBid(raw.id, {
        priceText: `${Math.round(reward * BID_RATIO * 100) / 100} ${raw.budgetCurrency || "USDC"}`,
        etaDays: DEFAULT_ETA_DAYS,
        approach: proposalText,
      });
      _attemptedTaskIds.add(raw.id);
      return result;
    } catch (err) {
      // Mark it attempted even on failure. A task that consistently fails
      // (e.g. quietly closed/expired server-side despite still listing as
      // "open") would otherwise get re-drafted and re-attempted forever,
      // every single /opentask run, burning LLM calls on something that
      // will never succeed — and worse, silently blocking the pipeline
      // from ever reaching the next-best real opportunity.
      _attemptedTaskIds.add(raw.id);
      throw err;
    }
  },
};

module.exports = openTaskStrategy;
