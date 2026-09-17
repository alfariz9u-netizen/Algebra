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
const moltMarketStrategy = {
  connectorName: "moltMarket",

  discoverOperation: "browseJobs",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const data = await connector.browseJobs({ status: "open" });
    return data.jobs || data.results || [];
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "moltmarket_job",
    rewardUsd: raw.budget_usdc ?? null,
    successProbability: Number(process.env.MOLTMARKET_DEFAULT_BID_WIN_RATE || 0.4),
    estimatedModelCostUsd: 0,
    platformFeeUsd: 0,
    riskLevel: "MEDIUM",
  }),

  toTask: (raw) => ({
    id: `moltmarket-bid-${raw.id}`,
    type: "communication",
    input: {
      context: `Open job on Molt Market — Title: "${raw.title}". Description: ${raw.description || "n/a"}. Budget: ${raw.budget_usdc ?? "unspecified"} USDC.`,
      goal: "Draft a concise, professional bid proposal for this job, explaining why you're a good fit and confirming you can meet the budget.",
    },
    untrustedContent: raw.description,
    untrustedSource: "moltmarket-job-listing",
    sourceConnector: "moltMarket",
  }),

  submitOperation: "bidOnJob",
  submitPermission: "SUBMIT_TASK",
  submit: async (connector, raw, bidMessageText) =>
    connector.bidOnJob(raw.id, {
      amountUsdc: raw.budget_usdc,
      message: bidMessageText,
      estimatedHours: raw.estimated_hours || 1,
    }),
};

module.exports = moltMarketStrategy;
