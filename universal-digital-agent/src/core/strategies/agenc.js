"use strict";

const { getSolUsdPrice } = require("../priceOracle");

/**
 * AgenC strategy for MarketplacePipeline. Unlike Molt Market's bid-first
 * flow, AgenC's model is claim-and-deliver directly (see
 * connectors/agenc.js) — so here the agent does produce the actual
 * deliverable, not just a proposal.
 *
 * PRICING: AgenC rewards are denominated in lamports (SOL). This now uses
 * a real, live SOL/USD price (src/core/priceOracle.js — CoinGecko, cached,
 * with an AGENC_SOL_USD_PRICE manual override). If the live fetch fails
 * and there's no cached price yet, this falls back to `rewardUsd: null`
 * (the same honest default as before the oracle existed) rather than
 * fabricating a number or crashing opportunity ranking entirely.
 */
const LAMPORTS_PER_SOL = 1_000_000_000;

const agencStrategy = {
  connectorName: "agenc",

  discoverOperation: "fetchIncomingTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => connector.fetchIncomingTasks(),

  toOpportunity: async (raw) => {
    const rewardSol = raw.input?.rewardLamports ? raw.input.rewardLamports / LAMPORTS_PER_SOL : null;

    let rewardUsd = null;
    let priceSource = "unavailable";
    if (rewardSol) {
      try {
        const { price, source } = await getSolUsdPrice();
        rewardUsd = rewardSol * price;
        priceSource = source;
      } catch (err) {
        priceSource = `error: ${err.message}`;
      }
    }

    return {
      id: raw.id,
      type: raw.type,
      rewardUsd,
      priceSource,
      successProbability: Number(process.env.AGENC_DEFAULT_SUCCESS_RATE || 0.5),
      estimatedModelCostUsd: 0,
      platformFeeUsd: Number(process.env.AGENC_ESTIMATED_TX_FEE_USD || 0), // real, tiny Solana tx fee — set if known
      riskLevel: "MEDIUM",
    };
  },

  toTask: (raw) => ({
    id: `agenc-${raw.id}`,
    type: raw.type || "business_automation",
    input: {
      spec: raw.input?.spec,
      process: raw.input?.spec,
      topic: raw.input?.spec,
    },
    untrustedContent: raw.input?.spec,
    untrustedSource: "agenc-task-listing",
    sourceConnector: "agenc",
  }),

  submitOperation: "submitDeliverable",
  submitPermission: "SUBMIT_TASK",
  submit: async (connector, raw, outputText) => connector.submitDeliverable(raw.id, { content: outputText, resultUri: null }),
};

module.exports = agencStrategy;
