"use strict";

/**
 * Real client for the Gemini API (Google AI Studio / Generative Language API).
 * Docs: https://ai.google.dev/gemini-api/docs
 *
 * IMPORTANT — model naming (as of September 2026):
 *   - gemini-2.0-flash is SHUT DOWN. Do NOT use it.
 *   - Current stable models: gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash
 *   - For agents, gemini-3.6-flash is optimized for agentic workflows.
 *   - Get a free API key at https://aistudio.google.com/apikey
 *
 * Free tier: Google AI Studio issues API keys with a genuine free quota.
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const API_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

class GeminiClient {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = DEFAULT_MODEL, apiBase = API_BASE } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.apiBase = apiBase.replace(/\/$/, "");
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  /**
   * Generate content via the Gemini API.
   * Uses the standard generateContent endpoint (v1beta).
   */
  async generate(systemPrompt, userPrompt) {
    if (!this.isConfigured) {
      throw new Error(
        "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey"
      );
    }

    // Model names for the v1beta API are prefixed with "models/".
    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    const url = `${this.apiBase}/${modelPath}:generateContent?key=${this.apiKey}`;

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
      const message =
        raw?.error?.message || `Gemini API request failed with status ${response.status}`;
      // Give a clear hint if the model name is stale.
      if (/not found|not available|unsupported/i.test(message)) {
        throw new Error(
          `${message} — The model "${this.model}" may have been shut down. ` +
            `Set GEMINI_MODEL to a current model such as "gemini-3.6-flash" or "gemini-3.8-flash".`
        );
      }
      throw new Error(message);
    }

    const text =
      raw?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

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
   * Real embeddings via Gemini's embedContent endpoint.
   * Uses gemini-embedding-001 (current stable embedding model).
   */
  async embed(text, model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001") {
    if (!this.isConfigured) {
      throw new Error(
        "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey"
      );
    }

    const modelPath = model.startsWith("models/") ? model : `models/${model}`;
    const url = `${this.apiBase}/${modelPath}:embedContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    });

    const raw = await response.json();

    if (!response.ok) {
      throw new Error(
        raw?.error?.message || `Gemini embedContent failed with status ${response.status}`
      );
    }

    return raw?.embedding?.values || [];
  }
}

module.exports = GeminiClient;
