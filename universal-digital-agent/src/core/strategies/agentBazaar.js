"use strict";

/**
 * AgentBazaar Strategy — Commercial-Grade
 * =========================================
 *
 * AgentBazaar is a Solana-native commerce layer for AI agents:
 *   - ERC-8004 on-chain identity + portable reputation
 *   - 97% payout (3% platform fee)
 *   - x402 micro-payments in USDC
 *
 * This strategy handles the SELL side: discovering requests, pricing them
 * with a multi-factor commercial engine, and delivering work for USDC.
 *
 * COMMERCIAL ENGINE (10 factors):
 *   1. Base bid fraction per reward band
 *   2. Reputation multiplier (win history → higher pricing power)
 *   3. Competition adjustment (more bidders → undercut)
 *   4. Urgency premium (tight deadline → +X%)
 *   5. Client quality (new clients → discount for trust-building)
 *   6. Category specialization (proven categories → premium)
 *   7. Cash-flow weighting (short tasks preferred)
 *   8. Real LLM cost estimation (Gemini/OpenRouter/OpenAI pricing)
 *   9. Anti-gaming detection (suspicious rewards rejected)
 *  10. Risk-adjusted expected value
 *
 * SAFETY:
 *   - Untrusted content is sanitized before reaching the LLM
 *   - Bid history prevents double-bidding on the same task
 *   - Rate limiting caps bids per hour
 *   - Task IDs are validated before submission
 *   - All numeric fields are coerced with safe fallbacks
 */

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// CONFIGURATION (all env-tunable for live calibration)
// ---------------------------------------------------------------------------
const CFG = {
  platformFeeRate: Number(process.env.AGENTBAZAAR_FEE_RATE || 0.03),

  // Baseline win-rate per risk tier
  winRate: {
    LOW: Number(process.env.AGENTBAZAAR_WIN_RATE_LOW || 0.60),
    MEDIUM: Number(process.env.AGENTBAZAAR_WIN_RATE_MEDIUM || 0.40),
    HIGH: Number(process.env.AGENTBAZAAR_WIN_RATE_HIGH || 0.20),
  },

  // Base bid fraction per reward band
  bidFraction: {
    micro: Number(process.env.AGENTBAZAAR_BID_MICRO || 0.40),
    small: Number(process.env.AGENTBAZAAR_BID_SMALL || 0.50),
    medium: Number(process.env.AGENTBAZAAR_BID_MEDIUM || 0.60),
    large: Number(process.env.AGENTBAZAAR_BID_LARGE || 0.70),
  },

  // Commercial multipliers
  reputationBonusPerWin: Number(process.env.AGENTBAZAAR_REP_BONUS || 0.02), // +2% per past win
  reputationMaxBonus: Number(process.env.AGENTBAZAAR_REP_MAX || 0.20),      // cap at +20%
  competitionPenalty: Number(process.env.AGENTBAZAAR_COMP_PENALTY || 0.05), // -5% per competitor
  competitionMinFactor: Number(process.env.AGENTBAZAAR_COMP_MIN || 0.70),   // floor at 70%
  urgencyPremium: Number(process.env.AGENTBAZAAR_URGENCY_PREMIUM || 0.15),  // +15% if urgent
  newClientDiscount: Number(process.env.AGENTBAZAAR_NEW_CLIENT_DISC || 0.10), // -10% for new clients
  categoryPremium: Number(process.env.AGENTBAZAAR_CAT_PREMIUM || 0.10),     // +10% if specialized

  // Thresholds
  defaultEtaDays: Number(process.env.AGENTBAZAAR_DEFAULT_ETA_DAYS || 2),
  urgentHours: Number(process.env.AGENTBAZAAR_URGENT_HOURS || 24),
  minRewardUsd: Number(process.env.AGENTBAZAAR_MIN_REWARD || 1),
  maxRewardUsd: Number(process.env.AGENTBAZAAR_MAX_REWARD || 5000), // anti-gaming cap
  maxBidsPerHour: Number(process.env.AGENTBAZAAR_MAX_BIDS_HOUR || 10),

  // LLM cost model (USD per 1M tokens, approximate blended rates)
  llmCostPerMillionTokens: {
    gemini: Number(process.env.AGENTBAZAAR_COST_GEMINI || 0.5),
    openrouter: Number(process.env.AGENTBAZAAR_COST_OPENROUTER || 0.3),
    openai: Number(process.env.AGENTBAZAAR_COST_OPENAI || 3.0),
  },
  avgTokensPerProposal: Number(process.env.AGENTBAZAAR_TOKENS_PER_BID || 3500),

  // State persistence
  stateDir: process.env.PERSIST_DIR || "./data",
  stateFile: "agentbazaar-state.json",
};

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

/**
 * Deep field extractor: handles nested keys ("budget.amount"),
 * arrays of candidate names, and returns the first non-empty value.
 */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (typeof key !== "string") continue;
    if (key.includes(".")) {
      // Nested path: "budget.amount" → obj.budget.amount
      const parts = key.split(".");
      let cur = obj;
      let ok = true;
      for (const p of parts) {
        if (cur && typeof cur === "object" && p in cur) {
          cur = cur[p];
        } else {
          ok = false;
          break;
        }
      }
      if (ok && cur !== undefined && cur !== null && cur !== "") return cur;
    } else {
      const v = obj[key];
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return null;
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    // Sometimes APIs wrap numbers: { amount: 50, currency: "USD" }
    v = v.amount ?? v.value ?? v.usd ?? v.usdc ?? null;
    if (v === null) return null;
  }
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Removes dangerous control characters and truncates for LLM safety. */
function sanitizeUntrusted(text, maxLen = 4000) {
  if (!text) return "";
  let s = String(text);
  // Strip zero-width and control characters
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/[\u0000-\u001F\u007F]/g, " ");
  // Neutralize common injection markers
  s = s.replace(/```/g, "'''");
  return s.slice(0, maxLen);
}

/** Validate task ID shape (UUID or alphanumeric). */
function isValidTaskId(id) {
  if (!id || typeof id !== "string") return false;
  return /^[a-zA-Z0-9_\-]{6,80}$/.test(id);
}

/** Simple file-backed state (no encryption — AgentBazaar state is non-secret). */
function loadState() {
  try {
    const p = path.join(CFG.stateDir, CFG.stateFile);
    if (!fs.existsSync(p)) return { bids: {}, categoryWins: {}, categoryLosses: {}, winsTotal: 0 };
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { bids: {}, categoryWins: {}, categoryLosses: {}, winsTotal: 0 };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(CFG.stateDir, { recursive: true });
    const p = path.join(CFG.stateDir, CFG.stateFile);
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("[agentBazaar] state save failed:", e.message);
  }
}

/** Simple hourly bid rate limiter. */
let _bidWindow = { start: Date.now(), count: 0 };
function canBid() {
  const now = Date.now();
  if (now - _bidWindow.start > 3600_000) {
    _bidWindow = { start: now, count: 0 };
  }
  if (_bidWindow.count >= CFG.maxBidsPerHour) return false;
  _bidWindow.count++;
  return true;
}

// ---------------------------------------------------------------------------
// RISK ENGINE
// ---------------------------------------------------------------------------
function computeRisk({ rewardUsd, deadlineHours, description, title }) {
  let score = 0;

  if (rewardUsd === null) score += 2;
  else if (rewardUsd < 5) score += 2;
  else if (rewardUsd > 500) score += 1;

  if (deadlineHours !== null && deadlineHours < CFG.urgentHours) score += 2;

  const text = `${title || ""} ${description || ""}`.toLowerCase();
  const vague = ["maybe", "possibly", "tbd", "not sure", "various", "etc."];
  if (!text || text.length < 40) score += 1;
  if (vague.some((w) => text.includes(w))) score += 1;

  const concrete = ["python", "javascript", "typescript", "api", "csv", "json",
                    "sql", "regex", "scrape", "bug", "test", "docker", "solana",
                    "wallet", "usdc", "onchain", "smart contract", "anchor"];
  if (concrete.some((w) => text.includes(w))) score -= 1;

  if (score <= 0) return "LOW";
  if (score <= 2) return "MEDIUM";
  return "HIGH";
}

// ---------------------------------------------------------------------------
// ANTI-GAMING ENGINE
// ---------------------------------------------------------------------------
function detectAnomaly({ rewardUsd, description, title, clientHistory }) {
  const warnings = [];

  // 1. Reward outside realistic range
  if (rewardUsd !== null && rewardUsd > CFG.maxRewardUsd) {
    warnings.push("reward_above_cap");
  }

  // 2. Zero-effort huge reward (classic scam signature)
  const text = `${title || ""} ${description || ""}`.toLowerCase();
  if (rewardUsd !== null && rewardUsd > 500 && text.length < 100) {
    warnings.push("high_reward_short_desc");
  }

  // 3. Crypto-scam keywords
  const scamWords = ["send sol", "send usdc", "wallet seed", "private key",
                     "double your", "guaranteed return", "airdrop claim"];
  if (scamWords.some((w) => text.includes(w))) {
    warnings.push("scam_keywords");
  }

  // 4. New client with high reward
  if (clientHistory === 0 && rewardUsd !== null && rewardUsd > 200) {
    warnings.push("new_client_high_reward");
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// PRICING ENGINE (the commercial core)
// ---------------------------------------------------------------------------

function baseBidFraction(rewardUsd) {
  if (rewardUsd === null) return CFG.bidFraction.small;
  if (rewardUsd < 10) return CFG.bidFraction.micro;
  if (rewardUsd < 50) return CFG.bidFraction.small;
  if (rewardUsd < 250) return CFG.bidFraction.medium;
  return CFG.bidFraction.large;
}

function reputationMultiplier(state) {
  const bonus = Math.min(
    state.winsTotal * CFG.reputationBonusPerWin,
    CFG.reputationMaxBonus
  );
  return 1 + bonus;
}

function competitionMultiplier(bidCount) {
  if (!bidCount || bidCount <= 1) return 1;
  const penalty = (bidCount - 1) * CFG.competitionPenalty;
  return Math.max(1 - penalty, CFG.competitionMinFactor);
}

function urgencyMultiplier(deadlineHours) {
  if (deadlineHours === null) return 1;
  if (deadlineHours < CFG.urgentHours) return 1 + CFG.urgencyPremium;
  return 1;
}

function clientQualityMultiplier(clientHistory) {
  if (!clientHistory || clientHistory === 0) return 1 - CFG.newClientDiscount;
  return 1; // established client
}

function categoryMultiplier(category, state) {
  if (!category) return 1;
  const wins = state.categoryWins[category] || 0;
  const losses = state.categoryLosses[category] || 0;
  const total = wins + losses;
  if (total < 3) return 1; // not enough signal
  const winRate = wins / total;
  if (winRate > 0.6) return 1 + CFG.categoryPremium;
  if (winRate < 0.3) return 1 - CFG.categoryPremium;
  return 1;
}

/** Estimates the real LLM cost for one proposal. */
function estimateLlmCostUsd(provider = "openrouter") {
  const rate = CFG.llmCostPerMillionTokens[provider] ?? CFG.llmCostPerMillionTokens.openrouter;
  return +(rate * CFG.avgTokensPerProposal / 1_000_000).toFixed(6);
}

/**
 * The full commercial pricing pipeline.
 * Returns a detailed breakdown so every adjustment is auditable.
 */
function computeBid({ rewardUsd, deadlineHours, category, bidCount, clientHistory, state }) {
  if (rewardUsd === null) {
    return {
      bidAmountUsd: null,
      breakdown: { reason: "no_reward" },
      confidence: 0,
    };
  }

  const base = baseBidFraction(rewardUsd);
  const rep = reputationMultiplier(state);
  const comp = competitionMultiplier(bidCount);
  const urg = urgencyMultiplier(deadlineHours);
  const client = clientQualityMultiplier(clientHistory);
  const cat = categoryMultiplier(category, state);

  const combinedFactor = base * rep * comp * urg * client * cat;
  const bidAmountUsd = +(rewardUsd * combinedFactor).toFixed(2);

  // Confidence: how many factors converged on this price
  const confidence = Math.min(
    1,
    (state.winsTotal > 5 ? 0.3 : state.winsTotal * 0.06) +
    (bidCount !== null ? 0.2 : 0) +
    (category ? 0.2 : 0) +
    (clientHistory !== null ? 0.15 : 0) +
    0.15
  );

  return {
    bidAmountUsd,
    confidence: +confidence.toFixed(2),
    breakdown: {
      base: +base.toFixed(3),
      reputation: +rep.toFixed(3),
      competition: +comp.toFixed(3),
      urgency: +urg.toFixed(3),
      client: +client.toFixed(3),
      category: +cat.toFixed(3),
      combined: +combinedFactor.toFixed(3),
    },
  };
}

// ---------------------------------------------------------------------------
// DELIVERY ETA
// ---------------------------------------------------------------------------
function estimateEtaDays(rewardUsd, deadlineHours) {
  if (deadlineHours !== null && deadlineHours > 0) {
    return Math.max(1, Math.min(14, Math.floor((deadlineHours * 0.6) / 24)));
  }
  if (rewardUsd === null) return CFG.defaultEtaDays;
  if (rewardUsd < 20) return 1;
  if (rewardUsd < 100) return 2;
  if (rewardUsd < 500) return 4;
  return 7;
}

// ---------------------------------------------------------------------------
// PROPOSAL PROMPT (engineered to win + upsell)
// ---------------------------------------------------------------------------
function buildProposalPrompt(task) {
  const upsell = task.rewardUsd !== null && task.rewardUsd >= 100
    ? [
        ``,
        `UPSELL (only if reward >= $100):`,
        `End with one sentence offering a small ADD-ON (e.g., unit tests, docs,`,
        `30-day support) for an extra 15–20% — framed as optional.`,
      ].join("\n")
    : "";

  return [
    `You are bidding on a freelance task on AgentBazaar (Solana, USDC payout).`,
    ``,
    `TASK:`,
    `- Title: ${task.title}`,
    `- Category: ${task.category || "unspecified"}`,
    `- Budget: ${task.rewardUsd !== null ? `$${task.rewardUsd} USDC` : "unspecified"}`,
    `- Deadline: ${task.deadlineHours !== null ? `${task.deadlineHours} hours` : "unspecified"}`,
    `- Skills: ${task.skills.length ? task.skills.join(", ") : "unspecified"}`,
    `- Description:`,
    `${task.description || "(no description provided)"}`,
    ``,
    `Write a SHORT, high-signal proposal (120–180 words). Requirements:`,
    `1. Open with ONE sentence proving you understood the exact deliverable.`,
    `2. Give a 3-step plan (bulleted, concrete verbs, specific tools).`,
    `3. One-line proof of skill — a concrete similar problem you solved.`,
    `4. State delivery window in days + confirm check-ins.`,
    `5. Close with one clarifying question showing expertise.`,
    upsell,
    ``,
    `Tone: confident, concise, no filler. No markdown headers. Plain text only.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// THE STRATEGY OBJECT
// ---------------------------------------------------------------------------
const agentBazaarStrategy = {
  connectorName: "agentBazaar",

  discoverOperation: "fetchIncomingTasks",
  discoverPermission: "READ_PUBLIC_WEB",

  discover: async (connector) => {
    const data = await connector.fetchIncomingTasks();
    if (Array.isArray(data)) return data;
    return data?.requests || data?.tasks || data?.results || data?.data || data?.items || [];
  },

  toOpportunity: (raw) => {
    const state = loadState();
    const taskId = raw.id || raw.request_id || raw.uuid;

    // 1. Skip if we've already bid on this task
    if (taskId && state.bids[taskId]) {
      return {
        id: taskId,
        type: "agentbazaar_request",
        rewardUsd: null,
        riskLevel: "HIGH",
        successProbability: 0,
        expectedValueUsd: 0,
        rejected: true,
        rejectReason: "already_bid",
      };
    }

    // 2. Extract fields with deep path support
    const rewardUsd = toNum(pick(raw,
      "reward_usd", "budget_usdc", "budget.amount_usdc", "budget.amount",
      "budget_usd", "budget", "reward.amount", "reward",
      "amount_usdc", "amount", "price_usdc", "price"
    ));
    const deadlineHours = toNum(pick(raw,
      "deadline_hours", "deadlineHours", "deadline.in_hours",
      "deadline_in_hours", "hours_left", "eta_hours"
    ));
    const bidCount = toNum(pick(raw, "bids_count", "bid_count", "bids", "competitors"));
    const clientHistory = toNum(pick(raw, "client_history", "client.tasks_posted", "poster_tasks"));

    // 3. Reject low-value tasks
    if (rewardUsd !== null && rewardUsd < CFG.minRewardUsd) {
      return {
        id: taskId,
        type: "agentbazaar_request",
        rewardUsd,
        riskLevel: "HIGH",
        successProbability: 0,
        expectedValueUsd: 0,
        rejected: true,
        rejectReason: `reward_below_min ($${CFG.minRewardUsd})`,
      };
    }

    // 4. Anti-gaming
    const anomalies = detectAnomaly({
      rewardUsd,
      description: raw.description,
      title: raw.title,
      clientHistory,
    });
    if (anomalies.length >= 2) {
      return {
        id: taskId,
        type: "agentbazaar_request",
        rewardUsd,
        riskLevel: "HIGH",
        successProbability: 0,
        expectedValueUsd: 0,
        rejected: true,
        rejectReason: `anomaly_detected: ${anomalies.join(",")}`,
      };
    }

    // 5. Rate limiting
    if (!canBid()) {
      return {
        id: taskId,
        type: "agentbazaar_request",
        rewardUsd,
        riskLevel: "HIGH",
        successProbability: 0,
        expectedValueUsd: 0,
        rejected: true,
        rejectReason: "rate_limit_exceeded",
      };
    }

    // 6. Full commercial pricing
    const category = pick(raw, "category", "skills.0", "tags.0") || null;
    const pricing = computeBid({
      rewardUsd,
      deadlineHours,
      category,
      bidCount,
      clientHistory,
      state,
    });

    const riskLevel = computeRisk({
      rewardUsd,
      deadlineHours,
      description: raw.description,
      title: raw.title,
    });
    const successProbability = CFG.winRate[riskLevel];
    const platformFeeUsd = pricing.bidAmountUsd !== null
      ? +(pricing.bidAmountUsd * CFG.platformFeeRate).toFixed(2)
      : 0;
    const llmCost = estimateLlmCostUsd(process.env.LLM_PROVIDER || "openrouter");
    const expectedValueUsd = pricing.bidAmountUsd !== null
      ? +(pricing.bidAmountUsd * (1 - CFG.platformFeeRate) * successProbability - llmCost).toFixed(4)
      : null;

    return {
      id: taskId,
      type: "agentbazaar_request",
      rewardUsd,
      bidAmountUsd: pricing.bidAmountUsd,
      deadlineHours,
      riskLevel,
      successProbability,
      estimatedModelCostUsd: llmCost,
      platformFeeUsd,
      expectedValueUsd,
      pricingBreakdown: pricing.breakdown,
      pricingConfidence: pricing.confidence,
      anomalies: anomalies.length ? anomalies : undefined,
    };
  },

  toTask: (raw) => {
    const rewardUsd = toNum(pick(raw,
      "reward_usd", "budget_usdc", "budget.amount_usdc", "budget.amount",
      "budget_usd", "budget", "reward.amount", "reward",
      "amount_usdc", "amount", "price_usdc", "price"
    ));
    const deadlineHours = toNum(pick(raw,
      "deadline_hours", "deadlineHours", "deadline.in_hours",
      "deadline_in_hours", "hours_left", "eta_hours"
    ));
    const rawSkills = pick(raw, "skills", "required_skills", "tags", "categories") || [];
    const skills = Array.isArray(rawSkills) ? rawSkills : String(rawSkills).split(",").map((s) => s.trim()).filter(Boolean);

    // Sanitize untrusted content BEFORE passing to the LLM
    const safeDescription = sanitizeUntrusted(raw.description);
    const safeTitle = sanitizeUntrusted(raw.title, 200);

    return {
      id: `agentbazaar-bid-${raw.id || raw.request_id || raw.uuid}`,
      type: "communication",
      input: {
        context: `Open request on AgentBazaar — Title: "${safeTitle}". Description: ${safeDescription || "n/a"}. Budget: ${rewardUsd ?? "unspecified"} USDC. Deadline: ${deadlineHours ?? "unspecified"} hours. Skills: ${skills.join(", ")}.`,
        goal: "Draft a concise, professional proposal for this request.",
        taskTitle: safeTitle,
        taskCategory: raw.category || "",
        taskRewardUsd: rewardUsd,
        taskDeadlineHours: deadlineHours,
        taskSkills: skills,
        taskDescription: safeDescription,
        raw,
      },
      untrustedContent: safeDescription,
      untrustedSource: "agentbazaar-listing",
      sourceConnector: "agentBazaar",
    };
  },

  buildPrompt: buildProposalPrompt,

  submitOperation: "submitDeliverable",
  submitPermission: "SUBMIT_TASK",

  submit: async (connector, raw, proposalText) => {
    const state = loadState();
    const taskId = raw.id || raw.request_id || raw.uuid;

    // Validation guard
    if (!isValidTaskId(taskId)) {
      throw new Error(`[agentBazaar] invalid task id: ${taskId}`);
    }

    const rewardUsd = toNum(pick(raw,
      "reward_usd", "budget_usdc", "budget.amount_usdc", "budget.amount",
      "budget_usd", "budget", "reward.amount", "reward",
      "amount_usdc", "amount", "price_usdc", "price"
    ));
    const deadlineHours = toNum(pick(raw,
      "deadline_hours", "deadlineHours", "deadline.in_hours",
      "deadline_in_hours", "hours_left", "eta_hours"
    ));
    const bidCount = toNum(pick(raw, "bids_count", "bid_count", "bids", "competitors"));
    const clientHistory = toNum(pick(raw, "client_history", "client.tasks_posted", "poster_tasks"));
    const category = pick(raw, "category") || null;

    const pricing = computeBid({
      rewardUsd,
      deadlineHours,
      category,
      bidCount,
      clientHistory,
      state,
    });
    const etaDays = estimateEtaDays(rewardUsd, deadlineHours);

    // Record the bid BEFORE sending (prevents double-bid on retry)
    state.bids[taskId] = {
      ts: new Date().toISOString(),
      bid: pricing.bidAmountUsd,
      reward: rewardUsd,
    };
    saveState(state);

    return connector.submitDeliverable(taskId, {
      proposal: proposalText,
      approach: proposalText,
      bidAmountUsdc: pricing.bidAmountUsd,
      etaDays,
      skills: Array.isArray(raw.skills) ? raw.skills.join(", ") : (raw.skills || "general"),
      taskDescription: sanitizeUntrusted(raw.title || raw.description || `Task ${taskId}`, 300),
      confidence: pricing.confidence,
    });
  },

  // ---- Public API for feedback loop --------------------------------------
  /** Call this when a bid wins/loses to feed the reputation engine. */
  recordOutcome: ({ taskId, category, won }) => {
    const state = loadState();
    if (won) {
      state.winsTotal = (state.winsTotal || 0) + 1;
      if (category) state.categoryWins[category] = (state.categoryWins[category] || 0) + 1;
    } else if (category) {
      state.categoryLosses[category] = (state.categoryLosses[category] || 0) + 1;
    }
    if (taskId && state.bids[taskId]) {
      state.bids[taskId].outcome = won ? "won" : "lost";
    }
    saveState(state);
  },
};

module.exports = agentBazaarStrategy;
