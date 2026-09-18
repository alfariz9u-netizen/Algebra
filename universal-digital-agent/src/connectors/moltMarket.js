"use strict";

/**
 * Molt Market connector — Solana-based agent-to-agent job marketplace.
 * Auth: MOLTMARKET_API_KEY (Bearer token).
 * Base URL: https://moltmarket.store
 *
 * IMPORTANT: The real endpoints (confirmed from the server's own error
 * response) are: /agents, /offers, /jobs, /reviews, /payments, /revenue.
 * Do NOT prefix them with /api/ — that returns 404.
 */

const DEFAULT_BASE_URL = process.env.MOLTMARKET_BASE_URL || "https://moltmarket.store";

class MoltMarketConnector {
  constructor({ apiKey = process.env.MOLTMARKET_API_KEY, baseUrl = DEFAULT_BASE_URL } = {}) {
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.name = "Molt Market";
  }

  // Framework expects a STRING status, not an object.
  status() {
    return process.env.MOLTMARKET_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers() {
    if (!this.apiKey) throw new Error("MOLTMARKET_API_KEY is not set.");
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async _request(method, path, { body, query } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: this._headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(
        `MoltMarket API ${method} ${path} failed: ${res.status} ${res.statusText}`
      );
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // ---- Health / Status ---------------------------------------------------

  /**
   * Molt Market does not expose a dedicated /health endpoint.
   * We use /jobs as a lightweight liveness probe.
   */
  async checkHealth() {
    return this._request("GET", "/jobs", { query: { status: "open", limit: 1 } });
  }

  // ---- Offers ------------------------------------------------------------

  async browseOffers({ status = "active", limit = 20 } = {}) {
    return this._request("GET", "/offers", { query: { status, limit } });
  }

  async publishOffer({ title, description, priceUsdc, category } = {}) {
    return this._request("POST", "/offers", {
      body: { title, description, price_usdc: priceUsdc, category },
    });
  }

  // ---- Jobs --------------------------------------------------------------

  async browseJobs({ status = "open", limit = 20 } = {}) {
    return this._request("GET", "/jobs", { query: { status, limit } });
  }

  async getJob(jobId) {
    return this._request("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }

  async createJob({ title, description, budgetUsdc } = {}) {
    return this._request("POST", "/jobs", {
      body: { title, description, budget_usdc: budgetUsdc },
    });
  }

  async bidOnJob(jobId, { amountUsdc, message, estimatedHours } = {}) {
    return this._request("POST", `/jobs/${encodeURIComponent(jobId)}/bids`, {
      body: {
        amount_usdc: amountUsdc,
        message,
        estimated_hours: estimatedHours,
      },
    });
  }

  async deliverWork(jobId, { content, attachments } = {}) {
    return this._request("POST", `/jobs/${encodeURIComponent(jobId)}/deliveries`, {
      body: { content, attachments },
    });
  }

  async approveDelivery(jobId) {
    return this._request("POST", `/jobs/${encodeURIComponent(jobId)}/approve`);
  }

  // ---- Agents / Reviews / Payments / Revenue ----------------------------

  async getMyNotifications() {
    return this._request("GET", "/agents/me/notifications");
  }

  async getMyReviews() {
    return this._request("GET", "/reviews");
  }

  async getMyPayments() {
    return this._request("GET", "/payments");
  }

  async getMyRevenue() {
    return this._request("GET", "/revenue");
  }
}

module.exports = MoltMarketConnector;
