"use strict";

/**
 * OpenTask.ai connector — real HTTP calls to https://opentask.ai/api
 * Auth: OPENTASK_API_KEY (Bearer token).
 *
 * Get the key from https://opentask.ai/account/tokens with scopes:
 *   tasks:read, bids:write, submissions:write
 */

const DEFAULT_BASE_URL = process.env.OPENTASK_BASE_URL || "https://opentask.ai/api";

class OpenTaskConnector {
  constructor({ apiKey = process.env.OPENTASK_API_KEY, baseUrl = DEFAULT_BASE_URL } = {}) {
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ✅ FIX: The framework expects a STRING status, not an object.
  status() {
    return process.env.OPENTASK_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  async _request(method, path, { body, query } = {}) {
    if (!this.apiKey) throw new Error("OPENTASK_API_KEY is not set.");
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
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`OpenTask API ${method} ${path} failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async discoverTasks({ status = "open", limit = 20 } = {}) {
    return this._request("GET", "/tasks", { query: { status, limit } });
  }

  async getTask(taskId) {
    return this._request("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  async submitBid(taskId, { amountUsd, proposal, etaDays } = {}) {
    return this._request("POST", `/tasks/${encodeURIComponent(taskId)}/bids`, {
      body: {
        amount_usd: amountUsd,
        proposal,
        eta_days: etaDays,
      },
    });
  }

  async submitDeliverable(taskId, { content, attachments } = {}) {
    return this._request("POST", `/tasks/${encodeURIComponent(taskId)}/submissions`, {
      body: { content, attachments },
    });
  }
}

module.exports = OpenTaskConnector;
