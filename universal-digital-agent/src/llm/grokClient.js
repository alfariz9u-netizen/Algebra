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

  /**
   * @param {string} systemPrompt - Role/instructions for the agent.
   * @param {string} userPrompt - The task-specific content.
   * @returns {Promise<{ text: string, raw: object }>}
   */
  async generate(systemPrompt, userPrompt) {
    if (!this.isConfigured) {
      throw new Error("XAI_API_KEY is not set. Create one at https://console.x.ai");
    }

    const url = `${this.apiBase}/chat/completions`;

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

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

    const text = raw?.choices?.[0]?.message?.content || "";
    return { text, raw };
  }
}

module.exports = GrokClient;
