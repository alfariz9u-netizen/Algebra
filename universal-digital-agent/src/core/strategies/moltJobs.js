"use strict";

/**
 * MoltJobs strategy for MarketplacePipeline.
 *
 * Like the OpenTask/Molt Market strategies, this drafts and submits a BID
 * first (never the finished work) — the deliverable is only produced
 * after a bid is accepted, via MoltJobsConnector.submitWork(), which is
 * not auto-chained here for the same reason: accepting a bid is the job
 * poster's decision, and there is no confirmed push/poll-for-acceptance
 * flow wired up yet (heartbeat + notifications would need to be added
 * first — see docs/setup.md's note on the equivalent OpenTask/MoltMarket
 * gap before relying on this for unattended delivery).
 */
const moltJobsStrategy = {
  connectorName: "moltJobs",

  discoverOperation: "discoverJobs",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    // Best-effort heartbeat so the agent is "active" and eligible to bid.
    // Never blocks discovery if it fails (e.g. MOLTJOBS_AGENT_ID unset).
    try {
      await connector.heartbeat();
    } catch {
      // swallow — discovery should still work read-only either way
    }
    const data = await connector.discoverJobs({ status: "OPEN" });
    return Array.isArray(data) ? data : data.jobs || data.results || [];
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "moltjobs_job",
    rewardUsd: raw.budgetUsdc ?? raw.bidAmount ?? raw.reward ?? null,
    successProbability: Number(process.env.MOLTJOBS_DEFAULT_BID_WIN_RATE || 0.4),
    estimatedModelCostUsd: 0,
    platformFeeUsd: 0,
    riskLevel: "MEDIUM",
  }),

  toTask: (raw) => ({
    id: `moltjobs-bid-${raw.id}`,
    type: "communication",
    input: {
      context: `Open job on MoltJobs — Title: "${raw.title}". Description: ${raw.description || "n/a"}. Budget: ${raw.budgetUsdc ?? raw.bidAmount ?? "unspecified"} USDC.`,
      goal: "Draft a concise, professional bid proposal for this job, explaining why you're a good fit.",
      raw,
    },
    untrustedContent: raw.description,
    untrustedSource: "moltjobs-listing",
    sourceConnector: "moltJobs",
  }),

  submitOperation: "applyToJob",
  submitPermission: "SUBMIT_TASK",
  submit: (connector, raw, proposalText) =>
    connector.applyToJob(raw.id, {
      bidAmount: raw.budgetUsdc ?? raw.bidAmount ?? 0,
      message: proposalText,
    }),
};

module.exports = moltJobsStrategy;
