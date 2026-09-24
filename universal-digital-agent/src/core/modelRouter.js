"use strict";

const GeminiClient = require("../llm/geminiClient");
const GrokClient = require("../llm/grokClient");
const GroqClient = require("../llm/groqClient");

/**
 * Model Router / Gateway (spec section 6). Not hard-coded to one provider —
 * picks a provider+model tier based on requested complexity, and falls back
 * across providers if the preferred one isn't configured or fails.
 *
 * Provider order per tier (falls back to the next on failure):
 *   1. Groq       — free tier, 14,400 req/day (fast, no abuse flagging)
 *   2. Gemini     — free tier, 500 req/day (gemini-3.5-flash-lite)
 *   3. Grok       — paid, last resort
 *
 * NOTE: "Groq" (with a q) is a different company from "Grok" (with a k,
 * xAI). Groq = fast free inference on LPU. Grok = paid xAI model.
 *
 * Tiers map to real, distinct models so "cheap" vs "strong" is a genuine
 * model choice, not a label:
 *   fast    -> groq llama-3.1-8b-instant   / gemini-3.5-flash-lite
 *   default -> groq llama-3.3-70b-versatile / gemini-3.5-flash-lite
 *   strong  -> groq llama-3.3-70b-versatile / gemini-3.5-flash-lite
 *
 * All Gemini model IDs below are current (Sep 2026) — the old
 * gemini-2.0-flash / gemini-1.5-pro IDs are shut down and would 404.
 */
const TIER_MODELS = {
  fast: {
    groq: process.env.GROQ_MODEL_FAST || "llama-3.1-8b-instant",
    gemini: process.env.GEMINI_MODEL_FAST || "gemini-3.5-flash-lite",
    grok: process.env.GROK_MODEL_FAST || "grok-4-fast",
  },
  default: {
    groq: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    gemini: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    grok: process.env.GROK_MODEL || "grok-4-fast",
  },
  strong: {
    groq: process.env.GROQ_MODEL_STRONG || "llama-3.3-70b-versatile",
    gemini: process.env.GEMINI_MODEL_STRONG || "gemini-3.5-flash-lite",
    grok: process.env.GROK_MODEL_STRONG || "grok-4",
  },
};

class ModelRouter {
  constructor() {
    this.preferred = (process.env.LLM_PROVIDER || "auto").toLowerCase();
  }

  _clientsForTier(tier) {
    const models = TIER_MODELS[tier] || TIER_MODELS.default;
    const groq = new GroqClient({ model: models.groq });
    const gemini = new GeminiClient({ model: models.gemini });
    const grok = new GrokClient({ model: models.grok });

    if (this.preferred === "gemini") return [gemini, groq, grok];
    if (this.preferred === "grok") return [grok, groq, gemini];
    // default: groq-first
    return [groq, gemini, grok];
  }

  /**
   * @param {"fast"|"default"|"strong"} tier
   * @param {{ tools?: Array, history?: Array }} [opts]
   */
  async generate(systemPrompt, userPrompt, tier = "default", opts = {}) {
    const clients = this._clientsForTier(tier);
    const errors = [];

    for (const client of clients) {
      if (!client.isConfigured) {
        errors.push(`${client.constructor.name}: not configured (missing API key)`);
        continue;
      }
      try {
        const result = await client.generate(systemPrompt, userPrompt, opts);
        return { ...result, provider: client.constructor.name, tier, model: client.model };
      } catch (err) {
        errors.push(`${client.constructor.name}: ${err.message}`);
      }
    }

    throw new Error(
      `No LLM provider could fulfill the request (tier=${tier}). Set GROQ_API_KEY and/or GEMINI_API_KEY and/or XAI_API_KEY.\n` +
        errors.join("\n")
    );
  }

  /**
   * Bounded tool-use loop — see original docstring for full behavior.
   * A tool failure does NOT throw out of the loop; the error is fed back
   * to the model as the tool's result so it can adapt.
   */
  async runToolLoop({
    systemPrompt,
    userPrompt,
    tier = "default",
    tools = [],
    executeTool,
    maxIterations = Number(process.env.MCP_MAX_TOOL_ITERATIONS || 3),
  }) {
    const history = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const toolCallLog = [];
    let last = null;

    for (let i = 0; i <= maxIterations; i++) {
      last = await this.generate(systemPrompt, userPrompt, tier, { tools, history });
      if (last.usage) {
        totalUsage.inputTokens += last.usage.inputTokens || 0;
        totalUsage.outputTokens += last.usage.outputTokens || 0;
        totalUsage.totalTokens +=
          last.usage.totalTokens ||
          (last.usage.inputTokens || 0) + (last.usage.outputTokens || 0);
      }

      if (!last.toolCall) {
        return {
          text: last.text,
          usage: totalUsage,
          provider: last.provider,
          model: last.model,
          tier,
          toolCallLog,
          iterations: i,
          truncated: false,
        };
      }
      if (i === maxIterations) {
        return {
          text: last.text || "",
          usage: totalUsage,
          provider: last.provider,
          model: last.model,
          tier,
          toolCallLog,
          iterations: i,
          truncated: true,
        };
      }

      let toolResult;
      try {
        toolResult = await executeTool(last.toolCall.name, last.toolCall.args);
        toolCallLog.push({ name: last.toolCall.name, args: last.toolCall.args, ok: true });
      } catch (err) {
        toolResult = { error: err.message };
        toolCallLog.push({
          name: last.toolCall.name,
          args: last.toolCall.args,
          ok: false,
          error: err.message,
        });
      }
      history.push({ role: "model", toolCall: last.toolCall });
      history.push({ role: "tool", name: last.toolCall.name, result: toolResult });
    }

    return {
      text: last?.text || "",
      usage: totalUsage,
      provider: last?.provider,
      model: last?.model,
      tier,
      toolCallLog,
      iterations: maxIterations,
      truncated: true,
    };
  }

  /** Embeddings — Gemini only. */
  async embed(text) {
    const gemini = new GeminiClient();
    if (!gemini.isConfigured) {
      throw new Error("Semantic cache requires GEMINI_API_KEY (embeddings are Gemini-only in this build).");
    }
    return gemini.embed(text);
  }
}

module.exports = ModelRouter;
