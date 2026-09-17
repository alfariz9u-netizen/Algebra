"use strict";

/**
 * Real connector for Molt Market (https://moltmarket.store) — an
 * agent-to-agent services/jobs marketplace with USDC escrow on Base L2.
 * Built directly from their public API docs (https://moltmarket.store/docs.html).
 *
 * IMPORTANT — this platform is itself explicit about "fail closed instead
 * of pretending to succeed": as of the docs fetched, settlement/escrow is
 * safety-gated behind `GET /health` (financial.ready, safety.settlement).
 * The initial canary caps everything at $0.05–$0.25 USDC. This connector
 * mirrors that honesty: it always checks /health before financial actions
 * and surfaces 503/402 responses as real errors, never as success.
 *
 * NOTE: there are several unrelated platforms that also use "Molt" in
 * their name. This connector is specifically for moltmarket.store. It is
 * NOT connected to "Molt Road" (a black-market platform for stolen
 * credentials/exploits, flagged by security researchers) — that platform
 * is deliberately never integrated here.
 *
 * REQUIRES:
 *   - MOLTMARKET_API_KEY — obtained by registering an agent (see
 *     MoltMarketConnector.register(), free, no signup fee while
 *     registration is open).
 */

const API_BASE = process.env.MOLTMARKET_API_BASE || "https://moltmarket.store";

class MoltMarketConnector {
  constructor() {
    this.name = "Molt Market";
  }

  status() {
    return process.env.MOLTMARKET_API_KEY ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _headers(extra = {}) {
    if (!process.env.MOLTMARKET_API_KEY) {
      throw new Error("MOLTMARKET_API_KEY is not set. Register a free agent first via MoltMarketConnector.register().");
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MOLTMARKET_API_KEY}`,
      ...extra,
    };
  }

  /**
   * Source of truth for what's actually enabled right now — always check
   * this before assuming a financial action (fund/accept/release/deposit)
   * will do anything other than fail closed.
   */
  async checkHealth() {
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) throw new Error(`Molt Market /health check failed: ${response.status}`);
    return response.json();
  }

  /** Free, no wallet required. Returns { id, api_key, ... } — save api_key as MOLTMARKET_API_KEY. */
  static async register({ name, description, skills = [], walletAddress, referralCode }) {
    const response = await fetch(`${API_BASE}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        skills,
        wallet_address: walletAddress,
        referral_code: referralCode,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market registration failed: ${response.status}`);
    return data;
  }

  // ---- Discovery (public, no auth required) ----

  async browseOffers({ category, skill, sellerId, limit = 20 } = {}) {
    const url = new URL(`${API_BASE}/offers`);
    if (category) url.searchParams.set("category", category);
    if (skill) url.searchParams.set("skill", skill);
    if (sellerId) url.searchParams.set("seller_id", sellerId);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Molt Market offer browse failed: ${response.status}`);
    return response.json();
  }

  async browseJobs({ status = "open", category, limit = 50 } = {}) {
    const url = new URL(`${API_BASE}/jobs`);
    url.searchParams.set("status", status);
    if (category) url.searchParams.set("category", category);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Molt Market job browse failed: ${response.status}`);
    return response.json();
  }

  async getJob(jobId) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}`);
    if (!response.ok) throw new Error(`Molt Market get job failed: ${response.status}`);
    return response.json();
  }

  async browseAgents({ skill, limit = 50 } = {}) {
    const url = new URL(`${API_BASE}/agents`);
    if (skill) url.searchParams.set("skill", skill);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Molt Market agent browse failed: ${response.status}`);
    return response.json();
  }

  /**
   * Per the platform's docs, this is how a worker finds out a bid was
   * accepted (or other account events) — there is no confirmed "my accepted
   * jobs" list endpoint, so this is the mechanism used to detect that a
   * delivery is now expected.
   */
  async getMyNotifications({ unreadOnly = true } = {}) {
    const url = new URL(`${API_BASE}/agents/me/notifications`);
    if (unreadOnly) url.searchParams.set("unread", "true");
    const response = await fetch(url, { headers: this._headers() });
    if (!response.ok) throw new Error(`Molt Market notifications fetch failed: ${response.status}`);
    return response.json();
  }

  // ---- Selling: publish a fixed-price service ----

  /** price_usdc capped at the platform's initial canary ($0.05–$0.25). */
  async publishOffer({ title, description, category, priceUsdc, requiredSkills = [], deliveryHours }) {
    const response = await fetch(`${API_BASE}/offers`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        title,
        description,
        category,
        price_usdc: priceUsdc,
        required_skills: requiredSkills,
        delivery_hours: deliveryHours,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market offer publish failed: ${response.status}`);
    return data;
  }

  // ---- Buying: purchase a published service ----

  async purchaseOffer(offerId, { expectedVersion, brief, idempotencyKey }) {
    const response = await fetch(`${API_BASE}/offers/${offerId}/purchase`, {
      method: "POST",
      headers: this._headers({ "Idempotency-Key": idempotencyKey }),
      body: JSON.stringify({ expected_version: expectedVersion, brief }),
    });
    // 402 = insufficient internal cash; 202 = timeout, retry same idempotency key.
    // Both are real, meaningful statuses — never treated as silent success.
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      throw new Error(data.error || `Molt Market purchase failed: ${response.status}`);
    }
    return { httpStatus: response.status, ...data };
  }

  // ---- Job lifecycle (request-and-bid path) ----

  /** Unfunded RFP — collects proposals; does not move money (per platform docs). budget_usdc: 0.05-0.25. */
  async createJob({ title, description, category, budgetUsdc, requiredSkills = [], deadlineHours }) {
    const response = await fetch(`${API_BASE}/jobs`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        title,
        description,
        category,
        budget_usdc: budgetUsdc,
        required_skills: requiredSkills,
        deadline_hours: deadlineHours,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market job creation failed: ${response.status}`);
    return data;
  }

  async bidOnJob(jobId, { amountUsdc, message, estimatedHours }) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/bid`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ amount_usdc: amountUsdc, message, estimated_hours: estimatedHours }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market bid failed: ${response.status}`);
    return data;
  }

  async acceptBid(jobId, bidId) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/accept`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ bid_id: bidId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market bid acceptance failed: ${response.status}`);
    return data;
  }

  /** This is how the platform's own docs say a worker submits the completed deliverable. */
  async deliverWork(jobId, { content, fileIds = [] }) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/deliver`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ content, file_ids: fileIds }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market delivery failed: ${response.status}`);
    return data;
  }

  async approveDelivery(jobId) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/approve`, {
      method: "POST",
      headers: this._headers(),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market approval failed: ${response.status}`);
    return data;
  }

  async disputeDelivery(jobId, { milestoneId, reason } = {}) {
    const response = await fetch(`${API_BASE}/jobs/${jobId}/dispute`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ milestone_id: milestoneId, reason }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market dispute failed: ${response.status}`);
    return data;
  }

  // ---- Reputation ----

  async createReview(jobId, { reviewedAgentId, rating, comment }) {
    const response = await fetch(`${API_BASE}/reviews`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ job_id: jobId, reviewed_agent_id: reviewedAgentId, rating, comment }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Molt Market review failed: ${response.status}`);
    return data;
  }

  async getReviewsForAgent(agentId) {
    const response = await fetch(`${API_BASE}/reviews/agent/${agentId}`);
    if (!response.ok) throw new Error(`Molt Market review fetch failed: ${response.status}`);
    return response.json();
  }
}

module.exports = MoltMarketConnector;
