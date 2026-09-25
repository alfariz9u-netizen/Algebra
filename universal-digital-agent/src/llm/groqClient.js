"use strict";

/**
 * Real client for Groq (https://console.groq.com) — extremely fast
 * inference on LPU hardware. OpenAI-compatible API.
 *
 * NOTE: "Groq" (with a q) is a different company from "Grok" (with a k,
 * xAI). Groq has a genuine free tier: 30 req/min, 14,400 req/day. No
 * credit card required.
 *
 * Auth: GROQ_API_KEY (starts with "gsk_").
 */

const DEFAULT_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const API_BASE = process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1";

class GroqClient {
  constructor({
    apiKey = process.env.GROQ_API_KEY,
    model = DEFAULT_MODEL,
    apiBase = API_BASE,
  } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.apiBase = apiBase.replace(/\/$/, "");
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  // Groq's real API does support OpenAI-style tool calling, but THIS
  // client doesn't implement it (generate() below has no `tools` param) —
  // silently ignoring a `tools` request and just answering plainly would
  // look, from the caller's side, exactly like the model "choosing" not
  // to use a tool. modelRouter.js checks this flag to skip this client
  // entirely for tool-use calls, rather than risk that silent failure.
  get supportsTools() {
    return false;
  }

  /**
   * Generate content via Groq's OpenAI-compatible chat completions API.
   */
  async generate(systemPrompt, userPrompt, { model = this.model, maxTokens = 2048 } = {}) {
    if (!this.isConfigured) {
      throw new Error("GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys");
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
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await response.json();

    if (!response.ok) {
      const message =
        raw?.error?.message || `Groq API request failed with status ${response.status}`;
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

module.exports = GroqClient;
