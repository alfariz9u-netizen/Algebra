"use strict";

/**
 * toku.agency strategy for MarketplacePipeline. Bid-first, same economic
 * logic as every other strategy here: draft and submit a bid, don't
 * produce the deliverable until a bid is actually accepted.
 *
 * Field names for job listings are not publicly documented in detail, so
 * this defensively checks several plausible spellings — the same lesson
 * learned from AgentMarket ("budget") and OpenTask ("budgetAmount").
 * Use /raw tokuagency after connecting to see the real shape and tighten
 * this if needed.
 */

const MIN_REWARD_USD = Number(process.env.TOKU_MIN_REWARD_USD || 1);
const BID_RATIO = Number(process.env.TOKU_BID_RATIO || 1.0);

// Session-lifetime de-dupe, same pattern as the other strategies — avoids
// re-bidding (or re-attempting a permanently-broken) job every cycle.
const _attemptedJobIds = new Set();

function extractReward(raw) {
  const candidates = [raw.reward_usd, raw.rewardUsd, raw.budget_usd, raw.budgetUsd, raw.price, raw.price_usd, raw.amount, raw.amount_usd];
  const found = candidates.find((v) => typeof v === "number");
  if (typeof found === "number") return found;
  const text = `${raw.title || ""} ${raw.description || ""}`;
  const m = text.match(/\$(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** A job with 100+ bids already (seen on the live board) is not worth competing on. */
function estimateWinRate(raw) {
  const base = Number(process.env.TOKU_DEFAULT_BID_WIN_RATE || 0.3);
  const bidCount = typeof raw.bidCount === "number" ? raw.bidCount : typeof raw.bids === "number" ? raw.bids : 0;
  if (bidCount >= 50) return 0.02;
  if (bidCount >= 15) return Math.max(0.05, base - 0.2);
  return base;
}

const tokuAgencyStrategy = {
  connectorName: "tokuAgency",

  discoverOperation: "discoverJobs",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const jobs = await connector.discoverJobs({ status: "open" });
    return jobs.filter((job) => job && job.id && !_attemptedJobIds.has(job.id));
  },

  toOpportunity: (raw) => {
    const reward = extractReward(raw);
    const usable = typeof reward === "number" && reward >= MIN_REWARD_USD;
    return {
      id: raw.id,
      type: "toku_job",
      rewardUsd: usable ? reward : 0,
      successProbability: usable ? estimateWinRate(raw) : 0,
      estimatedModelCostUsd: 0,
      platformFeeUsd: 0, // the 15% platform cut only applies on payout of an ACCEPTED bid, not the bid itself
      riskLevel: "MEDIUM",
    };
  },

  toTask: (raw) => ({
    id: `toku-bid-${raw.id}`,
    type: "communication",
    input: {
      context: `Open job on toku.agency — Title: "${raw.title}". Description: ${raw.description || "n/a"}. Reward: ${extractReward(raw) ?? "unspecified"} USD. Existing bids: ${raw.bidCount ?? raw.bids ?? "unknown"}.`,
      goal: "Draft a concise, professional bid/pitch for this job, explaining your approach and why you're a strong fit. Keep it distinct from a generic template given how many other agents may be bidding.",
      raw,
    },
    untrustedContent: raw.description,
    untrustedSource: "tokuagency-listing",
    sourceConnector: "tokuAgency",
  }),

  submitOperation: "submitBid",
  submitPermission: "SUBMIT_TASK",
  submit: async (connector, raw, proposalText) => {
    const reward = extractReward(raw);
    if (!(typeof reward === "number" && reward >= MIN_REWARD_USD)) {
      _attemptedJobIds.add(raw.id);
      throw new Error(`Skipping bid on job ${raw.id}: no usable reward found (checked reward_usd/budget_usd/price/amount and title/description text, below the $${MIN_REWARD_USD} floor or missing).`);
    }
    try {
      const result = await connector.submitBid(raw.id, {
        amountUsd: Math.round(reward * BID_RATIO * 100) / 100,
        proposal: proposalText,
      });
      _attemptedJobIds.add(raw.id);
      return result;
    } catch (err) {
      _attemptedJobIds.add(raw.id);
      throw err;
    }
  },
};

module.exports = tokuAgencyStrategy;
