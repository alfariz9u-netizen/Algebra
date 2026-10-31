"use strict";

const { getSolUsdPrice } = require("../priceOracle");
const AgencAdapter = require("../../connectors/agenc");

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

// A task's reward is in `rewardMint` when that is set (null = SOL). Only mints whose USD value is
// known without an oracle are priced; any other token is left unpriced rather than mis-read as SOL.
const USD_STABLECOINS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC (mainnet)
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT (mainnet)
};

const agencStrategy = {
  connectorName: "agenc",

  discoverOperation: "fetchIncomingTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => connector.fetchIncomingTasks(),

  toOpportunity: async (raw) => {
    // `rewardLamports` arrives as a decimal STRING (can exceed 2^53 for large token amounts).
    const amount = Number(raw.input?.rewardLamports);
    const hasReward = Number.isFinite(amount) && amount > 0;
    const mint = raw.input?.rewardMint || null;

    let rewardUsd = null;
    let priceSource = "unavailable";
    if (hasReward && !mint) {
      try {
        const { price, source } = await getSolUsdPrice();
        rewardUsd = (amount / LAMPORTS_PER_SOL) * price;
        priceSource = source;
      } catch (err) {
        priceSource = `error: ${err.message}`;
      }
    } else if (hasReward && USD_STABLECOINS[mint] !== undefined) {
      rewardUsd = amount / 10 ** USD_STABLECOINS[mint];
      priceSource = "stablecoin-1:1";
    } else if (hasReward) {
      priceSource = `unpriced token mint ${mint}`; // NOT SOL: never convert at the SOL price
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

  // Async: the listing only carries a title and a job-spec URI; the real brief has to be fetched
  // (https only, SSRF-guarded, hash-checked — see connectors/agenc.js). Without it the model used
  // to be handed the bare URI as "the spec". Falls back to the title when the spec can't be read.
  toTask: async (raw) => {
    const title = raw.input?.title || raw.input?.spec || "";
    const fetched = await AgencAdapter.fetchJobSpec(raw.input?.jobSpecUri, raw.input?.jobSpecHash);
    const spec = fetched ? `${title}\n\n${fetched.text}`.trim() : title;
    return {
      id: `agenc-${raw.id}`,
      type: raw.type || "business_automation",
      input: {
        spec,
        process: spec,
        topic: title || spec,
      },
      untrustedContent: spec,
      untrustedSource: "agenc-task-listing",
      sourceConnector: "agenc",
    };
  },

  submitOperation: "submitDeliverable",
  submitPermission: "SUBMIT_TASK",
  submit: async (connector, raw, outputText) =>
    connector.submitDeliverable(raw.id, { content: outputText, resultUri: null, jobSpecHash: raw.input?.jobSpecHash }),
};

module.exports = agencStrategy;
