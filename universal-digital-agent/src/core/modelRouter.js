"use strict";

const GeminiClient = require("../llm/geminiClient");
const OpenRouterClient = require("../llm/openRouterClient");
const GrokClient = require("../llm/grokClient");

/**
 * Model Router / Gateway (spec section 6). Not hard-coded to one provider —
 * picks a provider+model tier based on requested complexity, and falls back
 * across providers if the preferred one isn't configured or fails.
 *
 * Provider order per tier (falls back to the next on failure):
 *   1. Gemini     — free tier, 20 req/day (gemini-3.6-flash)
 *   2. OpenRouter — free tier, 50 req/day (llama-3.3-70b:free, etc.)
 *   3. Grok       — paid, last resort
 *
 * Tiers map to real, distinct models so "cheap" vs "strong" is a genuine
 * model choice, not a label:
 *   fast    -> small/fast models    (classification, routing, simple transforms)
 *   default -> balanced models      (most task execution)
 *   strong  -> large/capable models (high-risk / high-complexity tasks)
 */

const TIER_MODELS = {
  fast: {
    gemini: process.env.GEMINI_MODEL_FAST || "gemini-3.5-flash-lite",
    openrouter:
      process.env.OPENROUTER_MODEL_FAST || "google/gemma-3-27b-it:free",
    grok: process.env.GROK_MODEL_FAST || "grok-4-fast",
  },
  default: {
    gemini: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    openrouter:
      process.env.OPENROUTER_MODEL ||
      "meta-llama/llama-3.3-70b-instruct:free",
    grok: process.env.GROK_MODEL || "grok-4-fast",
  },
  strong: {
    gemini: process.env.GEMINI_MODEL_STRONG || "gemini-3.8-flash",
    openrouter:
      process.env.OPENROUTER_MODEL_STRONG ||
      "meta-llama/llama-3.3-70b-instruct:free",
    grok: process.env.GROK_MODEL_STRONG || "grok-4",
  },
};

class ModelRouter {
  constructor() {
    // "auto" (default) → Gemini → OpenRouter → Grok
    // "grok"          → Grok → OpenRouter → Gemini
    // "openrouter"    → OpenRouter → Gemini → Grok
    this.preferred = (process.env.LLM_PROVIDER || "auto").toLowerCase();
  }

  _clientsForTier(tier) {
    const models = TIER_MODELS[tier] || TIER_MODELS.default;
    const gemini = new GeminiClient({ model: models.gemini });
    const openrouter = new OpenRouterClient({ model: models.openrouter });
    const grok = new GrokClient({ model: models.grok });

    if (this.preferred === "grok") return [grok, openrouter, gemini];
    if (this.preferred === "openrouter") return [openrouter, gemini, grok];
    return [gemini, openrouter, grok]; // "auto" or anything else
  }

  /**
   * @param {"fast"|"default"|"strong"} tier
   */
  async generate(systemPrompt, userPrompt, tier = "default") {
    const clients = this._clientsForTier(tier);
    const errors = [];

    for (const client of clients) {
      const name = client.constructor.name;

      if (!client.isConfigured) {
        errors.push(`${name}: not configured (missing API key)`);
        continue;
      }

      try {
        const result = await client.generate(systemPrompt, userPrompt);
        return {
          ...result,
          provider: name,
          tier,
          model: client.model,
        };
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }

    throw new Error(
      `No LLM provider could fulfill the request (tier=${tier}). ` +
        `Set GEMINI_API_KEY and/or OPENROUTER_API_KEY and/or XAI_API_KEY.\n` +
        errors.join("\n")
    );
  }

  /**
   * Real embeddings, used by the semantic memory cache.
   * Gemini only — OpenRouter and xAI don't expose a compatible embeddings
   * endpoint in this build.
   */
  async embed(text) {
    const gemini = new GeminiClient();
    if (!gemini.isConfigured) {
      throw new Error(
        "Semantic cache requires GEMINI_API_KEY (embeddings are Gemini-only in this build)."
      );
    }
    return gemini.embed(text);
  }
}

module.exports = ModelRouter;
