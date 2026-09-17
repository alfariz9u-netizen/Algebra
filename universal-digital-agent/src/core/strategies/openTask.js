"use strict";

/**
 * OpenTask.ai strategy for MarketplacePipeline. Same bid-first economic
 * logic as Molt Market: draft and submit a bid/proposal on an open task
 * rather than producing the full deliverable before any commitment exists.
 *
 * HONESTY NOTE: built from OpenTask's documented high-level API surface
 * (see connectors/openTask.js) using a conventional REST field-naming
 * guess (`reward_usd`, `title`, `description`) — not verified field-by-field
 * against a live account. Treat unexpected `undefined` values in
 * `toOpportunity`/`toTask` as a signal the real field names differ and need
 * adjusting here.
 */
const openTaskStrategy = {
  connectorName: "openTask",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const data = await connector.discoverTasks({ status: "open" });
    return data.tasks || data.results || data || [];
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "opentask_task",
    rewardUsd: raw.reward_usd ?? raw.budget_usd ?? null,
    successProbability: Number(process.env.OPENTASK_DEFAULT_BID_WIN_RATE || 0.4),
    estimatedModelCostUsd: 0,
    platformFeeUsd: Number(process.env.OPENTASK_ESTIMATED_FEE_USD || 0),
    riskLevel: "MEDIUM",
  }),

  toTask: (raw) => ({
    id: `opentask-bid-${raw.id}`,
    type: "communication",
    input: {
      context: `Open task on OpenTask.ai — Title: "${raw.title}". Description: ${raw.description || "n/a"}. Reward: ${raw.reward_usd ?? "unspecified"} USD.`,
      goal: "Draft a concise, professional proposal for this task, explaining your approach and why you're a good fit.",
    },
    untrustedContent: raw.description,
    untrustedSource: "opentask-listing",
    sourceConnector: "openTask",
  }),

  submitOperation: "submitBid",
  submitPermission: "SUBMIT_TASK",
  submit: async (connector, raw, proposalText) =>
    connector.submitBid(raw.id, { amountUsd: raw.reward_usd, proposal: proposalText }),
};

module.exports = openTaskStrategy;
