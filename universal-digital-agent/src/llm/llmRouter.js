"use strict";

/**
 * LLM Router — tries multiple providers in order until one succeeds.
 *
 * Order:
 *   1. Gemini   (GEMINI_API_KEY)     — free tier: 20 req/day (gemini-3.6-flash)
 *   2. OpenRouter (OPENROUTER_API_KEY) — free tier: 50 req/day
 *   3. Grok     (XAI_API_KEY)         — paid, last resort
 *
 * This gives the agent resilience: if one provider is rate-limited or
 * unavailable, the next one takes over automatically.
 */

const GeminiClient = require("./geminiClient");
const OpenRouterClient = require("./openRouterClient");
const GrokClient = require("./grokClient");

class LLMRouter {
  constructor() {
    this.gemini = new GeminiClient();
    this.openrouter = new OpenRouterClient();
    this.grok = new GrokClient();
  }

  async generate(systemPrompt, userPrompt, opts = {}) {
    const errors = [];

    // 1) Gemini
    if (this.gemini.isConfigured) {
      try {
        console.log("[LLMRouter] Trying Gemini...");
        const result = await this.gemini.generate(systemPrompt, userPrompt);
        console.log("[LLMRouter] Gemini succeeded.");
        return { ...result, provider: "gemini" };
      } catch (err) {
        console.warn("[LLMRouter] Gemini failed:", err.message);
        errors.push({ provider: "gemini", error: err.message });
      }
    } else {
      console.warn("[LLMRouter] Gemini not configured, skipping.");
    }

    // 2) OpenRouter
    if (this.openrouter.isConfigured) {
      try {
        console.log("[LLMRouter] Trying OpenRouter...");
        const result = await this.openrouter.generate(systemPrompt, userPrompt, opts);
        console.log("[LLMRouter] OpenRouter succeeded.");
        return { ...result, provider: "openrouter" };
      } catch (err) {
        console.warn("[LLMRouter] OpenRouter failed:", err.message);
        errors.push({ provider: "openrouter", error: err.message });
      }
    } else {
      console.warn("[LLMRouter] OpenRouter not configured, skipping.");
    }

    // 3) Grok (last resort)
    if (this.grok && this.grok.isConfigured) {
      try {
        console.log("[LLMRouter] Trying Grok...");
        const result = await this.grok.generate(systemPrompt, userPrompt);
        console.log("[LLMRouter] Grok succeeded.");
        return { ...result, provider: "grok" };
      } catch (err) {
        console.warn("[LLMRouter] Grok failed:", err.message);
        errors.push({ provider: "grok", error: err.message });
      }
    } else {
      console.warn("[LLMRouter] Grok not configured, skipping.");
    }

    throw new Error(
      `No LLM provider could fulfill the request. Errors: ${JSON.stringify(errors, null, 2)}`
    );
  }
}

module.exports = LLMRouter;
