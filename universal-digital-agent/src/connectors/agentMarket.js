"use strict";

/**
 * Real connector for AgentMarket (https://agentmarket.space) — an
 * agent-to-agent task marketplace using a simple internal credit economy
 * (1 credit = $0.01 USD). No crypto wallet required; auth is a plain
 * X-API-Key header. New agents receive 100 free credits on registration.
 *
 * Docs used to build this: https://agentmarket.space/docs
 *
 * HONESTY NOTE: the public docs describe posting tasks (spending credits),
 * completing tasks (earning credits, 90% after a 10% platform fee), and an
 * investment system — but do NOT document any credits -> real-world cash
 * withdrawal endpoint. Treat earned credits as an in-platform balance
 * (useful for hiring other agents, investing, or building reputation)
 * unless/until a payout endpoint is confirmed — do not assume it is
 * withdrawable to a bank or wallet.
 *
 * REQUIRES:
 *   - AGENTMARKET_API_KEY — from POST /api/agents/register (see
 *     AgentMarketConnector.register() below; there is no web signup form
 *     for agents, only the API).
 */

const API_BASE = process.env.AGENTMARKET_API_BASE || "https://agentmarket.space/api";

class AgentMarketConnector {
  constructor() {
    this.name = "AgentMarket";
  }

  status() {
    return process.env.AGENTMARKET_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers(extra = {}) {
    if (!process.env.AGENTMARKET_API_KEY) {
      throw new Error("AGENTMARKET_API_KEY is not set. Register a free agent first via AgentMarketConnector.register().");
    }
    return {
      "Content-Type": "application/json",
      "X-API-Key": process.env.AGENTMARKET_API_KEY,
      ...extra,
    };
  }

  async _parse(response, label) {
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok || body.success === false) {
      // Include the real response body, not just the HTTP status — the
      // status alone (e.g. a bare 401) isn't enough to diagnose a bad
      // field name or an expired key.
      throw new Error(`AgentMarket ${label} failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body;
  }

  /**
   * Free — no wallet, no signup fee. Returns { api_key, id, ... } plus a
   * starting balance of 100 credits ($1.00). Save api_key as
   * AGENTMARKET_API_KEY.
   */
  static async register({ name, description, capabilities = [], pricePerTask, ownerEmail }) {
    const response = await fetch(`${API_BASE}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        capabilities,
        price_per_task: pricePerTask,
        owner_email: ownerEmail,
      }),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok || body.success === false) {
      throw new Error(`AgentMarket registration failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data;
  }

  // ---- Discovery (public, no auth required) ----

  async discoverTasks({ status = "open", capability, limit = 20 } = {}) {
    const url = new URL(`${API_BASE}/tasks`);
    url.searchParams.set("status", status);
    if (capability) url.searchParams.set("capability", capability);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url);
    const body = await this._parse(response, "GET /tasks");
    return body.data || [];
  }

  async getTask(taskId) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}`);
    const body = await this._parse(response, `GET /tasks/${taskId}`);
    return body.data;
  }

  async whoami() {
    const response = await fetch(`${API_BASE}/agents/me`, { headers: this._headers() });
    const body = await this._parse(response, "GET /agents/me");
    return body.data;
  }

  async getWallet() {
    const response = await fetch(`${API_BASE}/wallet`, { headers: this._headers() });
    const body = await this._parse(response, "GET /wallet");
    return body.data;
  }

  // ---- Bidding (preferred path — lets you set your own price/pitch) ----

  async bidOnTask(taskId, { bidAmount, message }) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/bid`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ bid_amount: bidAmount, message }),
    });
    const body = await this._parse(response, `POST /tasks/${taskId}/bid`);
    return body.data;
  }

  async listBids(taskId) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/bids`);
    const body = await this._parse(response, `GET /tasks/${taskId}/bids`);
    return body.data || [];
  }

  // ---- Direct accept (alternative to bidding — first to accept wins, no price negotiation) ----

  async acceptTask(taskId) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/accept`, {
      method: "POST",
      headers: this._headers(),
    });
    const body = await this._parse(response, `POST /tasks/${taskId}/accept`);
    return body.data;
  }

  // ---- Delivery ----

  async completeTask(taskId, { result }) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ result }),
    });
    const body = await this._parse(response, `POST /tasks/${taskId}/complete`);
    return body.data;
  }
}

module.exports = AgentMarketConnector;
