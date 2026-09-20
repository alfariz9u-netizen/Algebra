"use strict";

/**
 * Real connector for toku.agency — an active AI agent marketplace
 * (2500+ agents, 250+ open jobs at last check) with genuine real-money
 * payouts: 85% of each completed job is auto-credited to the agent's
 * wallet, withdrawable to a real bank account via Stripe Connect. Not
 * tokens, not credits, not crypto — actual USD.
 *
 * Confirmed real via public write-ups from the platform's own builder
 * (dev.to/lilyevesinclair) and the live homepage (toku.agency).
 *
 * HONESTY NOTE: registration and job-delivery endpoints are confirmed
 * from public examples:
 *   POST /api/agents/register { name, description, webhookUrl? }
 *     -> { agentId, apiKey }
 *   POST /api/jobs/:id/deliver { result }  (Bearer auth)
 * The job-LISTING endpoint (GET /api/jobs) and the BID-SUBMISSION
 * endpoint are inferred from the platform's own SDK method names
 * (api.getJobs(), and the homepage's "agents bid" job-board copy) but
 * their exact path/payload shape was not directly confirmed here.
 * Every method below surfaces the full response body on failure so a
 * wrong guess is immediately diagnosable via /log or /raw instead of a
 * silent dead end — the same lesson learned the hard way on OpenTask.
 *
 * REQUIRES:
 *   - TOKU_API_KEY — from TokuAgencyConnector.register() below, or
 *     curl -X POST https://www.toku.agency/api/agents/register
 */

const API_BASE = process.env.TOKU_API_BASE || "https://www.toku.agency/api";

class TokuAgencyConnector {
  constructor() {
    this.name = "toku.agency";
  }

  status() {
    return process.env.TOKU_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers(extra = {}) {
    if (!process.env.TOKU_API_KEY) {
      throw new Error("TOKU_API_KEY is not set. Register a free agent first (see TokuAgencyConnector.register()).");
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TOKU_API_KEY}`,
      ...extra,
    };
  }

  async _checkOk(response, label) {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`toku.agency ${label} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /** Free, no wallet, no approval queue. Returns { agentId, apiKey }. */
  static async register({ name, description, webhookUrl } = {}) {
    const response = await fetch(`${API_BASE}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, webhookUrl }),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`toku.agency registration failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body;
  }

  // ---- Discovery ----

  async discoverJobs({ status = "open", limit = 25 } = {}) {
    const url = new URL(`${API_BASE}/jobs`);
    url.searchParams.set("status", status);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    const body = await this._checkOk(response, "GET /jobs");
    return Array.isArray(body) ? body : body.jobs || body.results || [];
  }

  async getJob(jobId) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}`, { headers: this._headers() });
    return this._checkOk(response, `GET /jobs/${jobId}`);
  }

  async getProfile() {
    const response = await fetch(`${API_BASE}/agents/me`, { headers: this._headers() });
    return this._checkOk(response, "GET /agents/me");
  }

  // ---- Bidding (unconfirmed exact shape — see honesty note above) ----

  async submitBid(jobId, { amountUsd, proposal }) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/bid`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ amount_usd: amountUsd, amountUsd, proposal, message: proposal }),
    });
    return this._checkOk(response, `POST /jobs/${jobId}/bid`);
  }

  // ---- Delivery (confirmed real path) ----

  async deliverJob(jobId, result) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/deliver`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ result }),
    });
    return this._checkOk(response, `POST /jobs/${jobId}/deliver`);
  }
}

module.exports = TokuAgencyConnector;
