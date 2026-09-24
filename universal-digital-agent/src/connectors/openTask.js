"use strict";

/**
 * Real connector for OpenTask (https://opentask.ai).
 * Route confusion fix: bearer/agent routes use /api/agent/*, NOT /api/*.
 * Confirmed via official opentask-worker skill docs.
 *
 * Optimistic concurrency: the bid endpoint (POST /agent/tasks/{id}/bids)
 * requires the task's `updatedAt` timestamp in the body as
 * `expectedTaskUpdatedAt` — a string. The server returns 400 with
 * `issues: [{ code: "invalid_type", path: ["expectedTaskUpdatedAt"] }]`
 * when it is missing, so the caller (strategy) must always supply it.
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
      throw new Error("OPENTASK_API_KEY is not set.");
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

  // ---- READ (public/browser route is fine) --------------------------------

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

  // ---- WRITE (must use /agent/* routes with bearer token) ----------------

  /**
   * Submit a bid for an open task.
   *
   * @param {string} taskId
   * @param {object} opts
   * @param {string} opts.priceText - e.g. "9 USDC"
   * @param {number} opts.etaDays - delivery window in days
   * @param {string} opts.approach - the proposal text
   * @param {string} opts.expectedTaskUpdatedAt - REQUIRED. The task's
   *   `updatedAt` (or `createdAt` as fallback) as returned by /tasks.
   *   OpenTask uses this for optimistic concurrency and rejects the bid
   *   with 400 if it is missing or stale.
   */
  async submitBid(taskId, { priceText, etaDays, approach, expectedTaskUpdatedAt }) {
    if (!expectedTaskUpdatedAt) {
      throw new Error(
        `OpenTask submitBid for ${taskId}: expectedTaskUpdatedAt is required (optimistic concurrency) — caller must pass raw.updatedAt || raw.createdAt.`
      );
    }
    const response = await fetch(`${API_BASE}/agent/tasks/${taskId}/bids`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        priceText: priceText || "negotiable",
        etaDays: etaDays || 1,
        approach: approach || "",
        expectedTaskUpdatedAt,
      }),
    });
    return this._checkOk(response, `POST /agent/tasks/${taskId}/bids`);
  }

  async submitDeliverable(contractId, { deliverableUrl, notes }) {
    const response = await fetch(`${API_BASE}/agent/contracts/${contractId}/submissions`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ deliverableUrl, notes }),
    });
    return this._checkOk(response, `POST /agent/contracts/${contractId}/submissions`);
  }
}

module.exports = OpenTaskConnector;
