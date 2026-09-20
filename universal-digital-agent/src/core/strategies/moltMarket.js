"use strict";

/**
 * Molt Market strategy for MarketplacePipeline.
 *
 * Economically honest design choice: the agent does NOT produce the full
 * deliverable before winning the job — nothing is paid or guaranteed at
 * the "open job" stage. Instead it drafts and submits a BID (a proposal +
 * price), which is what a real worker on this platform actually does
 * first. Producing the finished work happens later, after a bid is
 * accepted — see `docs/setup.md` for why that step isn't auto-chained here
 * (acceptance is the job owner's decision, not something this agent can
 * poll for yet without a confirmed "my accepted jobs" endpoint).
 */

const MIN_BUDGET_USD = Number(process.env.MOLTMARKET_MIN_BUDGET_USD || 0.01);
// This platform's public canary phase caps every job at $0.05-$0.25 USDC
// (see docs/setup.md) — bid the full budget by default since underbidding
// an already-tiny amount buys no real competitive edge, but keep it
// overridable in case that cap is lifted and bigger jobs start appearing.
const BID_RATIO = Number(process.env.MOLTMARKET_BID_RATIO || 1.0);

/** The job-creation example in the docs uses budget_usdc, but the browse/list
 * response hasn't been confirmed to use the same key — be defensive rather
 * than assume, the same lesson learned from AgentMarket's "budget" field. */
function extractBudget(raw) {
  const candidates = [raw.budget_usdc, raw.budgetUsdc, raw.budget, raw.amount_usdc, raw.amountUsdc];
  const found = candidates.find((v) => typeof v === "number");
  return typeof found === "number" ? found : null;
}

// De-dupe within this process's lifetime only (resets on redeploy/restart —
// there's no cross-restart persistence here yet). Prevents /moltmarket
// re-bidding the exact same still-open job every time it's run in the same
// session, which would look like spam to a real job poster.
const _attemptedJobIds = new Set();

/** Rough, tunable win-rate heuristic: bigger budgets attract more bidders. */
function estimateWinRate(budgetUsd) {
  const base = Number(process.env.MOLTMARKET_DEFAULT_BID_WIN_RATE || 0.4);
  if (!(typeof budgetUsd === "number") || budgetUsd <= 0) return 0;
  if (budgetUsd >= 0.2) return Math.max(0.15, base - 0.15); // near the canary cap: assume more competition
  return base;
}

/** A cheap-but-not-silly hours estimate: scale gently with the payout instead of a flat "1". */
function estimateHours(budgetUsd) {
  if (!(typeof budgetUsd === "number") || budgetUsd <= 0) return 1;
  return Math.max(0.5, Math.min(8, Math.round(budgetUsd * 4 * 2) / 2)); // half-hour increments, capped at 8h
}

const moltMarketStrategy = {
  connectorName: "moltMarket",

  discoverOperation: "browseJobs",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const data = await connector.browseJobs({ status: "open" });
    const jobs = Array.isArray(data) ? data : data.jobs || data.results || [];
    return jobs.filter((job) => job && job.id && !_attemptedJobIds.has(job.id));
  },

  toOpportunity: (raw) => {
    const budget = extractBudget(raw);
    const usable = typeof budget === "number" && budget >= MIN_BUDGET_USD;
    return {
      id: raw.id,
      type: "moltmarket_job",
      rewardUsd: usable ? budget : 0,
      successProbability: usable ? estimateWinRate(budget) : 0,
      estimatedModelCostUsd: 0,
      platformFeeUsd: 0,
      riskLevel: "MEDIUM",
    };
  },

  toTask: (raw) => ({
    id: `moltmarket-bid-${raw.id}`,
    type: "communication",
    input: {
      context: `Open job on Molt Market — Title: "${raw.title}". Description: ${raw.description || "n/a"}. Budget: ${extractBudget(raw) ?? "unspecified"} USDC.`,
      goal: "Draft a concise, professional bid proposal for this job, explaining why you're a good fit and confirming you can meet the budget.",
      raw, // preserved so the post-approval auto-submit step can rebuild the real bid
    },
    untrustedContent: raw.description,
    untrustedSource: "moltmarket-job-listing",
    sourceConnector: "moltMarket",
  }),

  submitOperation: "bidOnJob",
  submitPermission: "SUBMIT_TASK",
  submit: async (connector, raw, bidMessageText) => {
    const budget = extractBudget(raw);
    if (!(typeof budget === "number" && budget >= MIN_BUDGET_USD)) {
      _attemptedJobIds.add(raw.id); // permanently unusable listing — don't re-draft for it every cycle
      throw new Error(`Skipping bid on job ${raw.id}: no usable budget (checked budget_usdc/budgetUsdc/budget/amount_usdc, got ${JSON.stringify(raw.budget_usdc)}).`);
    }
    try {
      const result = await connector.bidOnJob(raw.id, {
        amountUsdc: Math.round(budget * BID_RATIO * 100) / 100,
        message: bidMessageText,
        estimatedHours: raw.estimated_hours || estimateHours(budget),
      });
      _attemptedJobIds.add(raw.id);
      return result;
    } catch (err) {
      _attemptedJobIds.add(raw.id);
      throw err;
    }
  },
};

module.exports = moltMarketStrategy;
