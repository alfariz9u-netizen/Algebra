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
 * BID-EDITING FIX: OpenTask has NO endpoint to edit an existing bid's
 * priceText/etaDays/approach. The docs (termo.ai/skills/opentask) only
 * support:
 *   - POST  /api/agent/tasks/:taskId/bids        → create a new bid
 *   - PATCH /api/agent/bids/:bidId {action:"withdraw"} → withdraw a bid
 *   - PATCH /api/agent/bids/:bidId {action:"reject"}   → reject (task owner only)
 * To "update" a bid, you must withdraw the old one (by bidId) and POST a
 * fresh one. Earlier code tried PATCH /agent/tasks/:taskId/bids, which
 * returns 405 Method Not Allowed. That is fixed here.
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
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }

  // ---- READ ---------------------------------------------------------------

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

  /**
   * List the agent's own bids. Needed because withdrawing a bid requires
   * the bidId, not the taskId — and the only way to discover the bidId for
   * a task you already bid on is to list your bids and match by taskId.
   * Docs: GET /api/agent/bids?status=active (scope bids:read).
   */
  async getMyActiveBids({ status = "active", limit = 50 } = {}) {
    const url = new URL(`${API_BASE}/agent/bids`);
    if (status) url.searchParams.set("status", status);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: this._headers() });
    const data = await this._checkOk(response, "GET /agent/bids");
    return Array.isArray(data) ? data : data.bids || data.results || [];
  }

  // ---- WRITE --------------------------------------------------------------

  /**
   * Create a NEW bid for an open task.
   * The caller is responsible for handling 409 scope-change (reload + retry)
   * and 409 active-offer (withdraw existing + resubmit) — see strategies/openTask.js.
   */
  async submitBid(taskId, { priceText, etaDays, approach, expectedTaskUpdatedAt } = {}) {
    if (!expectedTaskUpdatedAt) {
      throw new Error(
        `OpenTask submitBid for ${taskId}: expectedTaskUpdatedAt is required — caller must pass raw.updatedAt || raw.createdAt.`
      );
    }
    const payload = {
      priceText: priceText || "negotiable",
      etaDays: etaDays || 1,
      approach: approach || "",
      expectedTaskUpdatedAt,
    };
    const response = await fetch(`${API_BASE}/agent/tasks/${taskId}/bids`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(payload),
    });
    return this._checkOk(response, `POST /agent/tasks/${taskId}/bids`);
  }

  /**
   * Withdraw the agent's active bid by its bidId.
   * Docs: PATCH /api/agent/bids/:bidId with body {action: "withdraw"}.
   */
  async withdrawBid(bidId) {
    const response = await fetch(`${API_BASE}/agent/bids/${bidId}`, {
      method: "PATCH",
      headers: this._headers(),
      body: JSON.stringify({ action: "withdraw" }),
    });
    return this._checkOk(response, `PATCH /agent/bids/${bidId}`);
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
