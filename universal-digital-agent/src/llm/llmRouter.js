"use strict";

/**
 * LLM Router — tries multiple providers in order until one succeeds.
 *
 * Order (Groq first — its free tier is the most generous and has no
 * automated abuse-flagging like Google's free tier):
 *   1. Groq       (GROQ_API_KEY)       — free: 14,400 req/day (fast)
 *   2. Gemini     (GEMINI_API_KEY)     — free: 500 req/day (gemini-3.5-flash-lite)
 *   3. OpenRouter (OPENROUTER_API_KEY) — free: 50 req/day
 *   4. Grok       (XAI_API_KEY)        — paid, last resort
 *
 * This gives the agent resilience: if one provider is rate-limited,
 * denied, or unavailable, the next one takes over automatically.
 *
 * NOTE: "Groq" (with a q) is a different company from "Grok" (with a k,
 * xAI). Groq = fast free inference. Grok = paid xAI model.
 */

const GeminiClient = require("./geminiClient");
const OpenRouterClient = require("./openRouterClient");
const GrokClient = require("./grokClient");
const GroqClient = require("./groqClient");

class LLMRouter {
  constructor() {
    this.groq = new GroqClient();
    this.gemini = new GeminiClient();
    this.openrouter = new OpenRouterClient();
    this.grok = new GrokClient();
  }

  async generate(systemPrompt, userPrompt, opts = {}) {
    const errors = [];

    // 1) Groq (primary — free, generous, fast)
    if (this.groq.isConfigured) {
      try {
        console.log("[LLMRouter] Trying Groq...");
        const result = await this.groq.generate(systemPrompt, userPrompt, opts);
        console.log("[LLMRouter] Groq succeeded.");
        return { ...result, provider: "groq" };
      } catch (err) {
        console.warn("[LLMRouter] Groq failed:", err.message);
        errors.push({ provider: "groq", error: err.message });
      }
    } else {
      console.warn("[LLMRouter] Groq not configured, skipping.");
    }

    // 2) Gemini (fallback #1)
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

    // 3) OpenRouter (fallback #2)
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

    // 4) Grok (last resort — paid)
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
