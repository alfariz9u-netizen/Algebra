"use strict";

/**
 * Real client for the xAI Grok API (OpenAI-compatible chat completions).
 * Docs: https://docs.x.ai/docs/api-reference
 *
 * NOTE: unlike Gemini, xAI does not offer an ongoing free API tier as of
 * 2026 — new accounts get a small one-time trial credit, then it's billed
 * per token. This client is fully real/functional, but running it costs
 * money once trial credits are used. Set XAI_API_KEY to use it.
 */

const DEFAULT_MODEL = process.env.GROK_MODEL || "grok-4-fast";
const API_BASE = process.env.XAI_API_BASE || "https://api.x.ai/v1";

class GrokClient {
  constructor({ apiKey = process.env.XAI_API_KEY, model = DEFAULT_MODEL, apiBase = API_BASE } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.apiBase = apiBase;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  // See geminiClient.js's identical getter for why this exists.
  get supportsTools() {
    return true;
  }

  /**
   * @param {string} systemPrompt - Role/instructions for the agent.
   * @param {string} userPrompt - The task-specific content.
   * @param {{ tools?: Array<{name,description,parameters}>, history?: Array }} [opts] -
   *   `tools` offers real function-calling via xAI's OpenAI-compatible API
   *   (https://docs.x.ai/docs/guides/function-calling) — omit for a plain
   *   single-turn call (unchanged existing behavior). `history` mirrors
   *   geminiClient.js's provider-agnostic turn shape.
   * @returns {Promise<{ text: string, raw: object, usage: object|null, toolCall: {name,args}|null }>}
   */
  async generate(systemPrompt, userPrompt, { tools, history = [] } = {}) {
    if (!this.isConfigured) {
      throw new Error("XAI_API_KEY is not set. Create one at https://console.x.ai");
    }

    const url = `${this.apiBase}/chat/completions`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    let pendingCallId = null;
    for (const turn of history) {
      if (turn.role === "model") {
        pendingCallId = `call_${messages.length}`;
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: pendingCallId, type: "function", function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args || {}) } }],
        });
      } else if (turn.role === "tool") {
        messages.push({ role: "tool", tool_call_id: pendingCallId, content: JSON.stringify(turn.result) });
      }
    }

    const body = { model: this.model, messages };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } } }));
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await response.json();

    if (!response.ok) {
      const message = raw?.error?.message || `xAI API request failed with status ${response.status}`;
      throw new Error(message);
    }

    const message_ = raw?.choices?.[0]?.message;
    const toolCallRaw = message_?.tool_calls?.[0];
    let toolCall = null;
    if (toolCallRaw) {
      let args = {};
      try {
        args = JSON.parse(toolCallRaw.function.arguments || "{}");
      } catch {
        args = {};
      }
      toolCall = { name: toolCallRaw.function.name, args };
    }
    const text = message_?.content || "";
    const usage = raw?.usage
      ? { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens, totalTokens: raw.usage.total_tokens }
      : null;
    return { text, raw, usage, toolCall };
  }
}

module.exports = GrokClient;
