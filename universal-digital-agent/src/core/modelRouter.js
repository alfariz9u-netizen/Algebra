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
   * @param {{ tools?: Array, history?: Array }} [opts] - see geminiClient.js/grokClient.js.
   *   Omit entirely for the original plain single-call behavior.
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
      `No LLM provider could fulfill the request (tier=${tier}). Set GEMINI_API_KEY and/or XAI_API_KEY.\n` +
        errors.join("\n")
    );
  }

  /**
   * Bounded tool-use loop (spec: "minimum necessary intelligence calls" —
   * this is the deliberate, opt-in exception, not a default). Calls
   * `generate()` up to `maxIterations + 1` times; whenever the model
   * requests a tool, `executeTool(name, args)` runs it and the result is
   * fed back for the next turn. Stops as soon as the model returns plain
   * text instead of a tool call, or when `maxIterations` is exhausted
   * (returns whatever text is available then, `truncated: true`) — never
   * loops unboundedly regardless of what the model asks for.
   *
   * A tool failure does NOT throw out of the loop — the error is fed back
   * to the model as the tool's result (as `{ error: message }`) so it can
   * adapt (try different args, a different tool, or give up gracefully
   * and answer with what it has), matching how a real tool-user would
   * behave, rather than crashing the whole task over one bad call.
   */
  async runToolLoop({ systemPrompt, userPrompt, tier = "default", tools = [], executeTool, maxIterations = Number(process.env.MCP_MAX_TOOL_ITERATIONS || 3) }) {
    const history = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const toolCallLog = [];
    let last = null;

    for (let i = 0; i <= maxIterations; i++) {
      last = await this.generate(systemPrompt, userPrompt, tier, { tools, history });
      if (last.usage) {
        totalUsage.inputTokens += last.usage.inputTokens || 0;
        totalUsage.outputTokens += last.usage.outputTokens || 0;
        totalUsage.totalTokens += last.usage.totalTokens || (last.usage.inputTokens || 0) + (last.usage.outputTokens || 0);
      }

      if (!last.toolCall) {
        return { text: last.text, usage: totalUsage, provider: last.provider, model: last.model, tier, toolCallLog, iterations: i, truncated: false };
      }
      if (i === maxIterations) {
        return { text: last.text || "", usage: totalUsage, provider: last.provider, model: last.model, tier, toolCallLog, iterations: i, truncated: true };
      }

      let toolResult;
      try {
        toolResult = await executeTool(last.toolCall.name, last.toolCall.args);
        toolCallLog.push({ name: last.toolCall.name, args: last.toolCall.args, ok: true });
      } catch (err) {
        toolResult = { error: err.message };
        toolCallLog.push({ name: last.toolCall.name, args: last.toolCall.args, ok: false, error: err.message });
      }
      history.push({ role: "model", toolCall: last.toolCall });
      history.push({ role: "tool", name: last.toolCall.name, result: toolResult });
    }
    return { text: last?.text || "", usage: totalUsage, provider: last?.provider, model: last?.model, tier, toolCallLog, iterations: maxIterations, truncated: true };
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
