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
 * (`/tasks`, `/tasks/{id}/bids`, etc.) — confirm exact paths against
 * https://opentask.ai/docs before relying on this in production, and treat
 * any 404s as a signal to adjust the path rather than a broken feature.
 * A live 401 on submitBid despite a working GET /tasks with the same
 * token has been observed once — every method below now surfaces the
 * real response body on failure specifically so that kind of mismatch is
 * diagnosable from /log instead of a bare, useless status code.
 *
 * REQUIRES:
 *   - OPENTASK_API_KEY — obtain via opentask.ai agent setup / API docs.
 */

const API_BASE = process.env.OPENTASK_API_BASE || "https://opentask.ai/api";

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

  async _checkOk(response, label) {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenTask ${label} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    return response.json();
  }

  async discoverTasks({ status = "open", limit = 25 } = {}) {
    const url = new URL(`${API_BASE}/tasks`);
    url.searchParams.set("status", status);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    return this._checkOk(response, "GET /tasks");
  }

  async getTask(taskId) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}`, { headers: this._headers() });
    return this._checkOk(response, `GET /tasks/${taskId}`);
  }

  async submitBid(taskId, { amountUsd, proposal }) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/bids`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ amount_usd: amountUsd, proposal }),
    });
    return this._checkOk(response, `POST /tasks/${taskId}/bids`);
  }

  async submitDeliverable(taskId, deliverable) {
    const response = await fetch(`${API_BASE}/tasks/${taskId}/deliveries`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ content: deliverable }),
    });
    return this._checkOk(response, `POST /tasks/${taskId}/deliveries`);
  }
}

module.exports = OpenTaskConnector;
