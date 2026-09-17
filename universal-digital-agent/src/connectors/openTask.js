"use strict";

/**
 * Real connector for OpenTask (https://opentask.ai) — an agent-to-agent
 * task marketplace with non-custodial payments/escrow. Confirmed real via
 * their public docs (https://opentask.ai/docs) and Terms of Service.
 * Agents authenticate via API token/OAuth and can discover tasks, submit
 * proposals/bids, deliver, and build reputation.
 *
 * HONESTY NOTE: opentask.ai/docs describes the API surface (tasks, bids,
 * contracts, deliveries, reviews) but I did not fetch every endpoint's
 * exact path/schema in this environment. The methods below cover the
 * documented high-level actions using a conventional REST shape
 * (`/v1/tasks`, `/v1/tasks/{id}/bids`, etc.) — confirm exact paths against
 * https://opentask.ai/docs before relying on this in production, and treat
 * any 404s as a signal to adjust the path rather than a broken feature.
 *
 * REQUIRES:
 *   - OPENTASK_API_KEY — obtain via opentask.ai agent setup / API docs.
 */

const API_BASE = process.env.OPENTASK_API_BASE || "https://opentask.ai/api/v1";

class OpenTaskConnector {
  constructor() {
    this.name = "OpenTask";
  }

  status() {
    return process.env.OPENTASK_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers() {
    if (!process.env.OPENTASK_API_KEY) {
      throw new Error("OPENTASK_API_KEY is not set. See https://opentask.ai/docs for agent setup.");
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENTASK_API_KEY}`,
    };
  }

  async discoverTasks({ status = "open", limit = 25 } = {}) {
    const url = new URL(`${API_BASE}/tasks`);
    url.searchParams.set("status", status);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    if (!response.ok) throw new Error(`OpenTask task discovery failed: ${response.status}`);
    return response.json();
  }

  async submitBid(taskId, { amountUsd, proposal }) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/bids`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ amount_usd: amountUsd, proposal }),
    });
    if (!response.ok) throw new Error(`OpenTask bid submission failed: ${response.status}`);
    return response.json();
  }

  async submitDeliverable(taskId, deliverable) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/deliveries`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ content: deliverable }),
    });
    if (!response.ok) throw new Error(`OpenTask delivery submission failed: ${response.status}`);
    return response.json();
  }
}

module.exports = OpenTaskConnector;
