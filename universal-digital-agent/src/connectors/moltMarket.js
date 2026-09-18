"use strict";

/**
 * Molt Market connector — Solana-based agent-to-agent job marketplace.
 * Auth: MOLTMARKET_API_KEY (Bearer token).
 * Base URL: https://moltmarket.store
 */

const DEFAULT_BASE_URL = process.env.MOLTMARKET_BASE_URL || "https://moltmarket.store";

class MoltMarketConnector {
  constructor({ apiKey = process.env.MOLTMARKET_API_KEY, baseUrl = DEFAULT_BASE_URL } = {}) {
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  status() {
    if (!this.apiKey) {
      return { connector: "moltMarket", status: "CREDENTIAL_REQUIRED", detail: "MOLTMARKET_API_KEY is not set." };
    }
    return { connector: "moltMarket", status: "CONNECTED", detail: `baseUrl=${this.baseUrl}` };
  }

  async _request(method, path, { body, query } = {}) {
    if (!this.apiKey) throw new Error("MOLTMARKET_API_KEY is not set.");
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`MoltMarket API ${method} ${path} failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async checkHealth() { return this._request("GET", "/api/health"); }
  async browseOffers({ status = "active" } = {}) { return this._request("GET", "/api/offers", { query: { status } }); }
  async browseJobs({ status = "open" } = {}) { return this._request("GET", "/api/jobs", { query: { status } }); }
  async getJob(jobId) { return this._request("GET", `/api/jobs/${encodeURIComponent(jobId)}`); }
  async publishOffer({ title, description, priceUsdc, category } = {}) {
    return this._request("POST", "/api/offers", { body: { title, description, price_usdc: priceUsdc, category } });
  }
  async createJob({ title, description, budgetUsdc } = {}) {
    return this._request("POST", "/api/jobs", { body: { title, description, budget_usdc: budgetUsdc } });
  }
  async bidOnJob(jobId, { amountUsdc, message, estimatedHours } = {}) {
    return this._request("POST", `/api/jobs/${encodeURIComponent(jobId)}/bids`, {
      body: { amount_usdc: amountUsdc, message, estimated_hours: estimatedHours },
    });
  }
  async deliverWork(jobId, { content, attachments } = {}) {
    return this._request("POST", `/api/jobs/${encodeURIComponent(jobId)}/deliveries`, { body: { content, attachments } });
  }
  async approveDelivery(jobId) {
    return this._request("POST", `/api/jobs/${encodeURIComponent(jobId)}/approve`);
  }
  async getMyNotifications() { return this._request("GET", "/api/me/notifications"); }
}

module.exports = MoltMarketConnector;
