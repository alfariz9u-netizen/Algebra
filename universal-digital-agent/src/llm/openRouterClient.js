"use strict";

/**
 * Real client for OpenRouter (https://openrouter.ai) — a unified gateway
 * to many models (Llama, Mistral, Qwen, Gemma, etc.) through one API.
 *
 * Free tier: 50 requests/day without any deposit; 1000 requests/day after
 * a one-time $10 deposit (the free models stay free). No credit card
 * required to start.
 *
 * Docs: https://openrouter.ai/docs
 * Get a key: https://openrouter.ai/keys
 */

const DEFAULT_MODEL =
  process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
const API_BASE = process.env.OPENROUTER_API_BASE || "https://openrouter.ai/api/v1";

class OpenRouterClient {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    model = DEFAULT_MODEL,
    apiBase = API_BASE,
    appUrl = process.env.APP_URL || "https://universal-digital-agent.onrender.com",
    appTitle = process.env.APP_TITLE || "Universal Digital Agent",
  } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.appUrl = appUrl;
    this.appTitle = appTitle;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  // See groqClient.js's identical getter for why this exists and why it's false.
  get supportsTools() {
    return false;
  }

  /**
   * Generate content via OpenRouter's OpenAI-compatible chat completions API.
   * @param {string} systemPrompt - Role/instructions for the agent.
   * @param {string} userPrompt - The task-specific content.
   * @returns {Promise<{ text: string, raw: object, usage: object|null }>}
   */
  async generate(systemPrompt, userPrompt, { model = this.model, maxTokens = 2048 } = {}) {
    if (!this.isConfigured) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Get a free key at https://openrouter.ai/keys"
      );
    }

    const url = `${this.apiBase}/chat/completions`;

    const body = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.appUrl,
        "X-Title": this.appTitle,
      },
      body: JSON.stringify(body),
    });

    const raw = await response.json();

    if (!response.ok) {
      const message =
        raw?.error?.message ||
        `OpenRouter API request failed with status ${response.status}`;
      throw new Error(message);
    }

    const text = raw?.choices?.[0]?.message?.content || "";

    const usage = raw?.usage
      ? {
          inputTokens: raw.usage.prompt_tokens,
          outputTokens: raw.usage.completion_tokens,
          totalTokens: raw.usage.total_tokens,
        }
      : null;

    return { text, raw, usage };
  }
}

module.exports = OpenRouterClient;
