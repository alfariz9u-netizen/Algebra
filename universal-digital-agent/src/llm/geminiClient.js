"use strict";

/**
 * Real client for the Gemini API (Google AI Studio / Generative Language API).
 * Docs: https://ai.google.dev/gemini-api/docs
 *
 * Free tier: Google AI Studio issues API keys with a genuine free quota for
 * models like gemini-2.0-flash / gemini-1.5-flash. Get a key at
 * https://aistudio.google.com/apikey and set GEMINI_API_KEY.
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

class GeminiClient {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = DEFAULT_MODEL, apiBase = API_BASE } = {}) {
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
      throw new Error(
        "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey"
      );
    }

    const url = `${this.apiBase}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const body = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = await response.json();

    if (!response.ok) {
      const message = raw?.error?.message || `Gemini API request failed with status ${response.status}`;
      throw new Error(message);
    }

    const text = raw?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const usage = raw?.usageMetadata
      ? {
          inputTokens: raw.usageMetadata.promptTokenCount,
          outputTokens: raw.usageMetadata.candidatesTokenCount,
          totalTokens: raw.usageMetadata.totalTokenCount,
        }
      : null;
    return { text, raw, usage };
  }

  /**
   * Real embeddings via Gemini's embedContent endpoint (text-embedding-004 /
   * gemini-embedding-001), used for the semantic cache. Also covered by the
   * free tier.
   */
  async embed(text, model = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004") {
    if (!this.isConfigured) {
      throw new Error(
        "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey"
      );
    }
    const url = `${this.apiBase}/models/${model}:embedContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    });
    const raw = await response.json();
    if (!response.ok) {
      throw new Error(raw?.error?.message || `Gemini embedContent failed with status ${response.status}`);
    }
    return raw?.embedding?.values || [];
  }
}

module.exports = GeminiClient;
