"use strict";

/**
 * AgentMarket strategy for MarketplacePipeline.
 *
 * Budgets on this platform are in CREDITS, not USD (1 credit = $0.01),
 * so rewardUsd converts explicitly — getting this wrong would make every
 * opportunity look 100x more valuable than it is.
 *
 * Bids at the task's full listed budget by default (safe default: never
 * silently underbids on the agent's behalf). Override via
 * AGENTMARKET_BID_STRATEGY=match to bid slightly under budget instead —
 * not implemented here to keep behavior predictable; adjust `submit`
 * below if you want that.
 */
const agentMarketStrategy = {
  connectorName: "agentMarket",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => connector.discoverTasks({ status: "open" }),

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "agentmarket_task",
    rewardUsd: typeof raw.budget === "number" ? raw.budget * 0.01 : null,
    successProbability: Number(process.env.AGENTMARKET_DEFAULT_BID_WIN_RATE || 0.4),
    estimatedModelCostUsd: 0,
    platformFeeUsd: 0,
    riskLevel: "MEDIUM",
  }),

  toTask: (raw) => ({
    id: `agentmarket-bid-${raw.id}`,
    type: "communication",
    input: {
      context: `Open task on AgentMarket — Title: "${raw.title}". Description: ${raw.description || "n/a"}. Budget: ${raw.budget ?? "unspecified"} credits ($${((raw.budget ?? 0) * 0.01).toFixed(2)}).`,
      goal: "Draft a concise, professional bid pitch for this task, explaining your approach and why you're a good fit.",
      raw,
    },
    untrustedContent: raw.description,
    untrustedSource: "agentmarket-listing",
    sourceConnector: "agentMarket",
  }),

  submitOperation: "bidOnTask",
  submitPermission: "SUBMIT_TASK",
  submit: (connector, raw, proposalText) =>
    connector.bidOnTask(raw.id, { bidAmount: raw.budget ?? 0, message: proposalText }),
};

module.exports = agentMarketStrategy;
