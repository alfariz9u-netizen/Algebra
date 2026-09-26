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
 *
 * 409 handling (added): when OpenTask returns 409 "You already have an
 * active offer on this task. Update it instead.", the agent was previously
 * failing silently and re-drafting the same proposal every cycle forever.
 * submitBid now detects that specific 409 and transparently calls
 * updateBid() instead, so the active offer is refreshed rather than
 * duplicated. updateBid() uses PATCH on the same /bids route — the
 * documented way to modify your existing active bid on a task.
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
      const err = new Error(`OpenTask ${label} failed: ${response.status} ${text.slice(0, 300)}`);
      err.status = response.status;
      err.body = text;
      throw err;
    }
    // 204 No Content has no body.
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }

  /** True when an error is the specific "you already have an active bid" 409. */
  _isActiveBidConflict(err) {
    if (!err || err.status !== 409) return false;
    const body = String(err.body || err.message || "").toLowerCase();
    return (
      body.includes("active offer") ||
      body.includes("active bid") ||
      body.includes("already have") ||
      body.includes("update it instead")
    );
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
   * Submit a new bid for an open task.
   *
   * On 409 "already have an active offer", this transparently falls through
   * to updateBid() with the same payload, so callers never have to handle
   * the conflict themselves — the end result is always "your active bid on
   * this task reflects the latest proposal".
   *
   * @param {string} taskId
   * @param {object} opts
   * @param {string} opts.priceText - e.g. "9 USDC"
   * @param {number} opts.etaDays - delivery window in days
   * @param {string} opts.approach - the proposal text
   * @param {string} opts.expectedTaskUpdatedAt - REQUIRED. The task's
   *   `updatedAt` (or `createdAt` as fallback) as returned by /tasks.
   */
  async submitBid(taskId, { priceText, etaDays, approach, expectedTaskUpdatedAt } = {}) {
    if (!expectedTaskUpdatedAt) {
      throw new Error(
        `OpenTask submitBid for ${taskId}: expectedTaskUpdatedAt is required (optimistic concurrency) — caller must pass raw.updatedAt || raw.createdAt.`
      );
    }
    const payload = {
      priceText: priceText || "negotiable",
      etaDays: etaDays || 1,
      approach: approach || "",
      expectedTaskUpdatedAt,
    };

    let response;
    try {
      response = await fetch(`${API_BASE}/agent/tasks/${taskId}/bids`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(payload),
      });
      return await this._checkOk(response, `POST /agent/tasks/${taskId}/bids`);
    } catch (err) {
      if (this._isActiveBidConflict(err)) {
        // We already have an active bid on this task — update it instead.
        return this.updateBid(taskId, payload);
      }
      throw err;
    }
  }

  /**
   * Update the agent's currently active bid on a task.
   * Uses PATCH on the same /bids route with the same payload shape as
   * submitBid — the documented way to modify an existing active bid.
   */
  async updateBid(taskId, { priceText, etaDays, approach, expectedTaskUpdatedAt } = {}) {
    if (!expectedTaskUpdatedAt) {
      throw new Error(
        `OpenTask updateBid for ${taskId}: expectedTaskUpdatedAt is required (optimistic concurrency) — caller must pass raw.updatedAt || raw.createdAt.`
      );
    }
    const payload = {
      priceText: priceText || "negotiable",
      etaDays: etaDays || 1,
      approach: approach || "",
      expectedTaskUpdatedAt,
    };
    const response = await fetch(`${API_BASE}/agent/tasks/${taskId}/bids`, {
      method: "PATCH",
      headers: this._headers(),
      body: JSON.stringify(payload),
    });
    return this._checkOk(response, `PATCH /agent/tasks/${taskId}/bids`);
  }

  async submitDeliverable(contractId, { deliverableUrl, notes } = {}) {
    const response = await fetch(`${API_BASE}/agent/contracts/${contractId}/submissions`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ deliverableUrl, notes }),
    });
    return this._checkOk(response, `POST /agent/contracts/${contractId}/submissions`);
  }
}

module.exports = OpenTaskConnector;
