"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Real LLM cost accounting.
 *
 * WHY THIS FILE EXISTS: before this fix, `universalAgent.js` recorded
 * `costUsd: 0` for every single completed task, unconditionally —
 * regardless of which provider actually served the request. That made
 * economicIntelligence.js's `totalCostUsd`/`totalProfitUsd`/`bestPlatform()`
 * /`bestModel()` numbers fictional: always-100%-margin, even on the calls
 * that hit Grok (this project's only genuinely paid, non-free-tier
 * provider — see modelRouter.js). Every strategy's pre-bid
 * `estimatedModelCostUsd` was ALSO hardcoded to 0 for 7 of 9 connectors.
 * This file fixes the root cause: real, sourced per-token pricing, plus
 * a real daily free-tier quota counter, so cost is $0 only when a call
 * genuinely lands inside a provider's free quota, and a real dollar
 * figure otherwise.
 *
 * PRICING SOURCES (checked directly, not guessed — see date on each):
 *   Groq gpt-oss-120b / gpt-oss-20b: console.groq.com pricing + rate-limit
 *     docs, corroborated across independent trackers dated 2026-09-28/29.
 *     $0.15 / $0.60 per 1M tokens (120b), $0.075 / $0.30 per 1M (20b).
 *   Groq FREE TIER: 30 RPM, **1,000 RPD** (not 14,400 — that figure was
 *     Groq's OLD free tier and was cut at some point in 2026; multiple
 *     independent sources measured the change directly against
 *     console.groq.com between June and September 2026), 8,000 TPM,
 *     200,000 TPD, per organization, for both gpt-oss models.
 *   Gemini 3.5 Flash-Lite (paid tier): $0.30 / $2.50 per 1M tokens —
 *     corroborated by OpenRouter, BenchLM.ai and CostGoat.ai, all dated
 *     September 2026. Free tier RPD is whatever modelRouter.js/the
 *     operator's own Gemini account reports; this file does not
 *     independently re-verify that number.
 *   Grok (xAI): pricing here is a DELIBERATE OVERESTIMATE, not a precise
 *     figure — see the warning below. Use it as "assume the expensive
 *     case" rather than a bill-accurate rate.
 *
 * THIS TABLE WILL GO STALE. LLM pricing changes constantly (Gemini's own
 * restructure in May 2026 is a good example). Treat PRICING_LAST_VERIFIED
 * below as a TODO date, not a guarantee, and re-verify before trusting
 * this for real accounting over a long period.
 */
const PRICING_LAST_VERIFIED = "2026-09-29";

// USD per 1,000,000 tokens.
const PRICING_TABLE = {
  GroqClient: {
    "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
    "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
    // Fallback for any other Groq model id this project might be pointed
    // at later — deliberately the more expensive of the two known rates,
    // so an unrecognized model errs toward overestimating cost rather
    // than silently under-charging it.
    __default: { input: 0.15, output: 0.6 },
  },
  GeminiClient: {
    "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
    __default: { input: 0.3, output: 2.5 },
  },
  GrokClient: {
    // WARNING (real, current uncertainty — not guessed away): as of
    // September 2026, xAI has been retiring/redirecting older model IDs
    // through several Grok releases in a single year. The literal model
    // strings this project's modelRouter.js hardcodes ("grok-4-fast",
    // "grok-4") were, per multiple sources checked directly on 2026-09-28,
    // EITHER already redirected server-side to a newer model (legacy
    // aliases reportedly route to Grok 4.3, $1.25/$2.50 per 1M) OR still
    // resolve to their original, separately-priced models — sources
    // disagreed and this file does not have a way to test the operator's
    // actual account. Priced here at the CURRENT FLAGSHIP'S rate
    // ($2.00/$6.00 per 1M, Grok 4.7) as the conservative "assume the
    // expensive case" default, specifically so this system never
    // under-counts Grok spend. If your account's real Grok bill is
    // consistently lower, that's a sign the alias resolved to a cheaper
    // model than assumed here — update PRICING_TABLE.GrokClient once
    // confirmed against your own xAI Console usage page, and move
    // PRICING_LAST_VERIFIED forward.
    __default: { input: 2.0, output: 6.0 },
  },
};

// Groq and Gemini both offer a real free daily quota; Grok (xAI) does
// not — every Grok call is billed. Only providers listed here get the
// "free until quota exhausted" treatment; anything else is priced.
const FREE_DAILY_REQUEST_QUOTA = {
  GroqClient: Number(process.env.GROQ_FREE_RPD_OVERRIDE || 1000), // see PRICING_TABLE comment above for the source
  GeminiClient: Number(process.env.GEMINI_FREE_RPD_OVERRIDE || 500), // matches modelRouter.js's existing documented assumption
};

function priceFor(provider, model) {
  const table = PRICING_TABLE[provider];
  if (!table) return null; // unknown provider entirely — caller decides the fallback
  return table[model] || table.__default;
}

/**
 * Tracks how many requests each free-tier provider has made TODAY (UTC
 * calendar day), persisted to a small JSON file so a process restart
 * doesn't lose the count and silently believe the day is fresh again.
 * This is deliberately simple (a per-provider integer counter, reset at
 * UTC midnight) — good enough to answer "are we still inside the free
 * quota right now", not a byte-perfect mirror of each provider's own
 * rolling-window rate limiter.
 */
class DailyQuotaTracker {
  constructor({ persistDir } = {}) {
    this._file = path.join(persistDir || process.env.PERSIST_DIR || "./data", "llm-quota-state.json");
    this._state = this._load();
  }

  _today() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  }

  _load() {
    try {
      if (fs.existsSync(this._file)) {
        const raw = JSON.parse(fs.readFileSync(this._file, "utf8"));
        if (raw.day === this._today()) return raw;
      }
    } catch {
      /* corrupt or unreadable — start fresh rather than crash accounting */
    }
    return { day: this._today(), counts: {} };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(this._state), "utf8");
    } catch (err) {
      console.warn(`[llmPricing] quota state write failed (non-fatal): ${err.message}`);
    }
  }

  _rollIfNewDay() {
    const today = this._today();
    if (this._state.day !== today) this._state = { day: today, counts: {} };
  }

  /** How many free requests are left today for this provider (Infinity if it has no tracked quota). */
  remainingToday(provider) {
    this._rollIfNewDay();
    const quota = FREE_DAILY_REQUEST_QUOTA[provider];
    if (quota === undefined) return Infinity;
    const used = this._state.counts[provider] || 0;
    return Math.max(0, quota - used);
  }

  /** Call once per real request to that provider — increments today's counter. */
  recordRequest(provider) {
    this._rollIfNewDay();
    this._state.counts[provider] = (this._state.counts[provider] || 0) + 1;
    this._save();
  }
}

/**
 * The one function everything else should call.
 * @param {string} provider - generation.provider, i.e. client.constructor.name (e.g. "GroqClient")
 * @param {string} model - generation.model
 * @param {{inputTokens?: number, outputTokens?: number}} usage
 * @param {DailyQuotaTracker} [quotaTracker] - when given, a Groq/Gemini
 *   call inside today's free quota costs $0 and consumes one unit of
 *   quota; omit it (or pass null) to always price at the paid rate
 *   regardless of quota — useful for a PRE-bid worst-case estimate,
 *   where you don't want to assume free capacity you might not have
 *   left by the time the task actually runs.
 */
function estimateCostUsd(provider, model, usage = {}, quotaTracker = null) {
  if (!provider) return 0;
  // FIX: only take the "free" branch for providers that actually HAVE a
  // tracked daily quota (Groq, Gemini). remainingToday() returns Infinity
  // for any other provider — including Grok, which has no free tier at
  // all in this project — specifically so the dashboard can show "no
  // quota tracked" distinctly from "0 left, exhausted". But Infinity > 0
  // is also true, so without this explicit membership check, Grok would
  // have been silently treated as free the moment a quotaTracker was
  // passed in — exactly backwards from the point of this file. Caught by
  // test/llm_pricing.test.js's "Grok has no tracked free quota" case.
  const hasTrackedQuota = Object.prototype.hasOwnProperty.call(FREE_DAILY_REQUEST_QUOTA, provider);
  if (quotaTracker && hasTrackedQuota && quotaTracker.remainingToday(provider) > 0) {
    quotaTracker.recordRequest(provider);
    return 0;
  }
  const rate = priceFor(provider, model);
  if (!rate) return 0; // genuinely unknown/unpriced provider — no invented number
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cost = (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
  return Math.round(cost * 1e6) / 1e6; // 6 decimal places — sub-cent costs are the norm here
}

module.exports = { estimateCostUsd, DailyQuotaTracker, PRICING_TABLE, PRICING_LAST_VERIFIED, FREE_DAILY_REQUEST_QUOTA };
