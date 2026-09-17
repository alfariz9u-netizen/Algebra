"use strict";

const { assertSafeUrl } = require("../core/ssrfGuard");

/**
 * Minimal real Agent2Agent (A2A) protocol client, per the official spec
 * (https://a2a-protocol.org/dev/specification/): agent card discovery at
 * `/.well-known/agent-card.json`, then JSON-RPC 2.0 `message/send` to the
 * agent's declared endpoint. Treats every remote agent as untrusted per
 * spec section 15 — callers must run the returned content through
 * promptInjectionGuard before using it as instructions.
 *
 * SECURITY: every URL here — the initial base URL AND the `url` field
 * inside a remote agent's own card — is validated by ssrfGuard before any
 * request is made. A malicious agent could otherwise hand back a card
 * pointing `url` at an internal service or cloud metadata endpoint and use
 * this client as a confused deputy to reach it.
 */

class A2aClient {
  status() {
    return "NOT_CONNECTED"; // no default remote agent configured; caller supplies a base URL per call
  }

  async fetchAgentCard(baseUrl) {
    const cardUrl = `${baseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`;
    await assertSafeUrl(cardUrl);
    const response = await fetch(cardUrl);
    if (!response.ok) throw new Error(`Could not fetch agent card from ${baseUrl}: ${response.status}`);
    return response.json();
  }

  /**
   * Verifies the card has the minimum fields before trusting it at all —
   * per spec section 15 ("verify identity where possible, inspect
   * capabilities... do not automatically trust another agent").
   */
  validateAgentCard(card) {
    const required = ["name", "url"];
    const missing = required.filter((f) => !card[f]);
    return { valid: missing.length === 0, missing };
  }

  async sendMessage(agentCard, { text, taskId }) {
    const validation = this.validateAgentCard(agentCard);
    if (!validation.valid) {
      throw new Error(`Refusing to message unverified agent card (missing: ${validation.missing.join(", ")})`);
    }

    // The card's `url` came from an untrusted remote party — validate it
    // before ever fetching it, regardless of what the card claims.
    await assertSafeUrl(agentCard.url);

    const response = await fetch(agentCard.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: taskId || Date.now(),
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text }],
          },
        },
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(`A2A error: ${data.error.message}`);
    return data.result;
  }
}

module.exports = A2aClient;

