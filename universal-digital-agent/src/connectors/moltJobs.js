"use strict";

/**
 * Real connector for MoltJobs (https://moltjobs.io) — an API-first job
 * marketplace for autonomous agents, with USDC settlement via on-chain
 * escrow on Base L2 and a Turnkey-managed non-custodial wallet created
 * automatically for every registered agent (no manual wallet funding
 * required to start bidding — unlike AgenC/AgentBazaar on Solana).
 *
 * Docs used to build this: https://moltjobs.io/docs
 *
 * REQUIRES:
 *   - MOLTJOBS_API_KEY  — from app.moltjobs.io/agents/new (register agent,
 *                         "no credit card required", ~30 seconds)
 *   - MOLTJOBS_AGENT_ID — optional; shown alongside the API key on the
 *                         dashboard. Some endpoints (apply/heartbeat) take
 *                         an explicit agentId; if unset, this connector
 *                         omits it and relies on the token identifying
 *                         the agent (whichever the live API expects,
 *                         errors below always include the raw response
 *                         body so a mismatch is easy to spot in /log).
 *
 * New agents get 10 free bids/month before needing purchased credits.
 */

const API_BASE = process.env.MOLTJOBS_API_BASE || "https://api.moltjobs.io/v1";

class MoltJobsConnector {
  constructor() {
    this.name = "MoltJobs";
  }

  status() {
    return process.env.MOLTJOBS_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers(extra = {}) {
    if (!process.env.MOLTJOBS_API_KEY) {
      throw new Error("MOLTJOBS_API_KEY is not set. Register a free agent at https://app.moltjobs.io/agents/new first.");
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MOLTJOBS_API_KEY}`,
      ...extra,
    };
  }

  /** Every response is wrapped as { data: ... } per MoltJobs' API convention. */
  async _unwrap(response, label) {
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      // Always surface the real response body, not just the status code —
      // this is what actually lets you diagnose a 401/422/etc instead of
      // guessing blind (learned the hard way debugging other connectors).
      throw new Error(`MoltJobs ${label} failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
    }
    return "data" in body ? body.data : body;
  }

  // ---- Discovery (read-only) ----

  async discoverJobs({ status = "OPEN", vertical, limit = 20 } = {}) {
    const url = new URL(`${API_BASE}/jobs`);
    url.searchParams.set("status", status);
    if (vertical) url.searchParams.set("vertical", vertical);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    return this._unwrap(response, "GET /jobs");
  }

  async getJob(jobId) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}`, { headers: this._headers() });
    return this._unwrap(response, `GET /jobs/${jobId}`);
  }

  async whoami() {
    const response = await fetch(`${API_BASE}/agents/me`, { headers: this._headers() });
    return this._unwrap(response, "GET /agents/me");
  }

  // ---- Presence (required for the agent to be eligible to bid) ----

  /** Agents auto-activate with 30-minute presence windows — call this before bidding. */
  async heartbeat() {
    const agentId = process.env.MOLTJOBS_AGENT_ID;
    const path = agentId ? `/agents/${agentId}/heartbeat` : "/agents/me/heartbeat";
    const response = await fetch(`${API_BASE}${path}`, { method: "POST", headers: this._headers() });
    return this._unwrap(response, "POST heartbeat");
  }

  // ---- Bidding ----

  async applyToJob(jobId, { bidAmount, message } = {}) {
    const body = { bidAmount, message };
    if (process.env.MOLTJOBS_AGENT_ID) body.agentId = process.env.MOLTJOBS_AGENT_ID;
    const response = await fetch(`${API_BASE}/jobs/${jobId}/apply`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    return this._unwrap(response, `POST /jobs/${jobId}/apply`);
  }

  // ---- Delivery (after a bid is accepted) ----

  async submitWork(jobId, { outputData, proofUrl } = {}) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/submit`, {
      method: "PATCH",
      headers: this._headers(),
      body: JSON.stringify({ outputData, proofUrl }),
    });
    return this._unwrap(response, `PATCH /jobs/${jobId}/submit`);
  }

  // ---- Wallet (read-only balance check; withdrawal intentionally not wired into the pipeline) ----

  async getWallet() {
    const response = await fetch(`${API_BASE}/wallets/me`, { headers: this._headers() });
    return this._unwrap(response, "GET /wallets/me");
  }
}

module.exports = MoltJobsConnector;
