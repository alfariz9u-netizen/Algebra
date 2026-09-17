"use strict";

const GeminiClient = require("../llm/geminiClient");
const GrokClient = require("../llm/grokClient");

/**
 * Model Router / Gateway (spec section 6). Not hard-coded to one provider —
 * picks a provider+model tier based on requested complexity, and falls back
 * across providers if the preferred one isn't configured or fails.
 *
 * Tiers map to real, distinct models so "cheap" vs "strong" is a genuine
 * model choice, not a label:
 *   fast   -> gemini-2.0-flash-lite / grok-4-fast   (classification, routing, simple transforms)
 *   default-> gemini-2.0-flash / grok-4-fast        (most task execution)
 *   strong -> gemini-1.5-pro / grok-4               (high-risk / high-complexity tasks)
 */
const TIER_MODELS = {
  fast: {
    gemini: process.env.GEMINI_MODEL_FAST || "gemini-2.0-flash-lite",
    grok: process.env.GROK_MODEL_FAST || "grok-4-fast",
  },
  default: {
    gemini: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    grok: process.env.GROK_MODEL || "grok-4-fast",
  },
  strong: {
    gemini: process.env.GEMINI_MODEL_STRONG || "gemini-1.5-pro",
    grok: process.env.GROK_MODEL_STRONG || "grok-4",
  },
};

class ModelRouter {
  constructor() {
    this.preferred = (process.env.LLM_PROVIDER || "auto").toLowerCase();
  }

  _clientsForTier(tier) {
    const models = TIER_MODELS[tier] || TIER_MODELS.default;
    const gemini = new GeminiClient({ model: models.gemini });
    const grok = new GrokClient({ model: models.grok });
    return this.preferred === "grok" ? [grok, gemini] : [gemini, grok];
  }

  /**
   * @param {"fast"|"default"|"strong"} tier
   */
  async generate(systemPrompt, userPrompt, tier = "default") {
    const clients = this._clientsForTier(tier);
    const errors = [];

    for (const client of clients) {
      if (!client.isConfigured) {
        errors.push(`${client.constructor.name}: not configured (missing API key)`);
        continue;
      }
      try {
        const result = await client.generate(systemPrompt, userPrompt);
        return { ...result, provider: client.constructor.name, tier, model: client.model };
      } catch (err) {
        errors.push(`${client.constructor.name}: ${err.message}`);
      }
    }

    throw new Error(
      `No LLM provider could fulfill the request (tier=${tier}). Set GEMINI_API_KEY and/or XAI_API_KEY.\n` +
        errors.join("\n")
    );
  }

  /** Real embeddings, used by the semantic memory cache. Gemini only — xAI has no public embeddings endpoint. */
  async embed(text) {
    const gemini = new GeminiClient();
    if (!gemini.isConfigured) {
      throw new Error("Semantic cache requires GEMINI_API_KEY (embeddings are Gemini-only in this build).");
    }
    return gemini.embed(text);
  }
}

module.exports = ModelRouter;
