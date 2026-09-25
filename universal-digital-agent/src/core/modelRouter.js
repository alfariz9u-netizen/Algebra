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
 * MODEL IDS (Sep 2026):
 *   Groq production models (per console.groq.com/docs/models):
 *     - openai/gpt-oss-120b       (strong/default)
 *     - openai/gpt-oss-20b        (fast)
 *   The previous `llama-3.3-70b-versatile` was retired on 16 Aug 2026.
 *
 *   Gemini current models (Sep 2026):
 *     - gemini-3.5-flash-lite     (all tiers — 500 req/day free)
 *   The old gemini-1.5-pro / gemini-2.0-flash IDs are shut down.
 */
const TIER_MODELS = {
  fast: {
    groq: process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b",
    gemini: process.env.GEMINI_MODEL_FAST || "gemini-3.5-flash-lite",
    grok: process.env.GROK_MODEL_FAST || "grok-4-fast",
  },
  default: {
    groq: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    gemini: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    grok: process.env.GROK_MODEL || "grok-4-fast",
  },
  strong: {
    groq: process.env.GROQ_MODEL_STRONG || "openai/gpt-oss-120b",
    gemini: process.env.GEMINI_MODEL_STRONG || "gemini-3.5-flash-lite",
    grok: process.env.GROK_MODEL_STRONG || "grok-4",
  },
};

class ModelRouter {
  constructor() {
    this.preferred = (process.env.LLM_PROVIDER || "auto").toLowerCase();
  }

  _clientsForTier(tier, { requireTools = false } = {}) {
    const models = TIER_MODELS[tier] || TIER_MODELS.default;
    const groq = new GroqClient({ model: models.groq });
    const gemini = new GeminiClient({ model: models.gemini });
    const grok = new GrokClient({ model: models.grok });

    const ordered =
      this.preferred === "gemini" ? [gemini, groq, grok] : this.preferred === "grok" ? [grok, groq, gemini] : [groq, gemini, grok]; // default: groq-first

    // Groq (and any future OpenAI-compatible addition here) doesn't
    // implement function-calling in this codebase's client — see
    // groqClient.js's supportsTools getter. Trying it first for a tool-use
    // call would get a plain-text answer back with no error, indistinguishable
    // from the model genuinely choosing not to use a tool. When tools are
    // actually being offered this call, only route to providers that can
    // honor them.
    return requireTools ? ordered.filter((c) => c.supportsTools) : ordered;
  }

  /**
   * @param {"fast"|"default"|"strong"} tier
   * @param {{ tools?: Array, history?: Array }} [opts]
   */
  async generate(systemPrompt, userPrompt, tier = "default", opts = {}) {
    const requireTools = Boolean(opts.tools && opts.tools.length);
    const clients = this._clientsForTier(tier, { requireTools });
    if (requireTools && clients.length === 0) {
      throw new Error(
        "A tool-use call needs a function-calling-capable provider, but none is configured. Set GEMINI_API_KEY and/or XAI_API_KEY (Groq/OpenRouter don't support tools here)."
      );
    }
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

  /** Real embeddings, used by the semantic memory cache. Gemini only. */
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
