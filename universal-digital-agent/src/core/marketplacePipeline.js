"use strict";

const { normalizeOpportunity, rankOpportunities } = require("./opportunityEngine");
const riskEngine = require("./riskEngine");

/**
 * The bridge between capabilities and connectors. Previously,
 * `UniversalAgent.processTask()` could run a capability against arbitrary
 * task input, and `UniversalAgent.callConnector()` could safely call a
 * connector — but nothing connected the two: the agent never automatically
 * discovered a real job, worked it, and submitted the result. This module
 * is that missing loop, per connector, always routed through
 * `callConnector` (kill switch + support check + rate limit + audit) and
 * through the SAME risk/approval gate `processTask` itself uses.
 *
 * Every step is honest about failure: a connector without credentials
 * throws from inside `callConnector`'s wrapped function and the cycle
 * reports that opportunity as failed rather than skipping it silently.
 */
class MarketplacePipeline {
  constructor(agent) {
    this.agent = agent;
  }

  /** Shared approval gate — mirrors the logic UniversalAgent.processTask uses for capabilities. */
  _checkApproval(permissionAction) {
    const needsApproval = riskEngine.requiresHumanApproval(permissionAction, this.agent.autonomyLevel);
    return { needsApproval, riskLevel: riskEngine.classify(permissionAction) };
  }

  /**
   * Best-effort: shares a short, factual summary of a completed task on
   * The Colony so other agents (and future runs of this one) can learn
   * from it. Never throws — a learning-sharing failure must not fail the
   * underlying task that already succeeded.
   */
  async _shareLearning(connectorName, task, outcome) {
    if (this.agent.connectors.status("colony") !== "CONNECTED") return { shared: false, reason: "colony not connected" };
    const approval = this._checkApproval("PUBLISH");
    if (approval.needsApproval) return { shared: false, reason: "PUBLISH requires human approval at current autonomy level" };

    try {
      await this.agent.callConnector("colony", "postFinding", "PUBLISH", () =>
        this.agent.connectors.get("colony").postFinding({
          title: `Completed a ${task.type} task sourced from ${connectorName}`,
          body: `Capability used: ${outcome.capability}. QA score: ${outcome.meta?.qaScore ?? "n/a"}. Result summary: ${String(outcome.output || "").slice(0, 500)}`,
          colony: "general",
          postType: "finding",
        })
      );
      return { shared: true };
    } catch (err) {
      return { shared: false, reason: err.message };
    }
  }

  /**
   * Generic cycle: discover -> rank by expected value -> for each accepted
   * opportunity, run it through the agent -> submit the deliverable ->
   * record economics -> best-effort share the learning.
   *
   * @param {object} strategy - connector-specific mapping, see
   *   strategies/moltMarket.js and strategies/agenc.js for real examples.
   */
  async runCycle(strategy, { minExpectedValue = 0, maxOpportunities = 1 } = {}) {
    const discoverApproval = this._checkApproval(strategy.discoverPermission);
    if (discoverApproval.needsApproval) {
      return { status: "pending_human_approval", stage: "discover", riskLevel: discoverApproval.riskLevel };
    }

    const rawList = await this.agent.callConnector(
      strategy.connectorName,
      strategy.discoverOperation,
      strategy.discoverPermission,
      () => strategy.discover(this.agent.connectors.get(strategy.connectorName))
    );

    const opportunities = await Promise.all(
      rawList.map(async (raw) => normalizeOpportunity(await strategy.toOpportunity(raw), strategy.connectorName))
    );
    for (const opp of opportunities) {
      this.agent.economics.record({ type: "task_discovered", connector: strategy.connectorName });
    }

    const { accepted, rejected } = rankOpportunities(opportunities, { minExpectedValue });
    for (const opp of rejected) {
      this.agent.economics.record({ type: "task_rejected", connector: strategy.connectorName, expectedValueUsd: opp.expectedValue });
    }

    const results = [];
    for (const opp of accepted.slice(0, maxOpportunities)) {
      results.push(await this._processOpportunity(strategy, opp));
    }

    return { status: "completed", discovered: opportunities.length, accepted: accepted.length, rejected: rejected.length, results };
  }

  async _processOpportunity(strategy, opportunity) {
    this.agent.economics.record({ type: "task_accepted", connector: strategy.connectorName, expectedValueUsd: opportunity.expectedValue });

    const task = strategy.toTask(opportunity.raw);
    const outcome = await this.agent.processTask(task);

    if (outcome.status === "pending_human_approval") {
      // The capability itself (e.g. "communication") was already held for
      // approval at the current autonomy level — nothing to submit yet.
      return { opportunity, outcome, submission: { status: "pending_human_approval", riskLevel: outcome.riskLevel } };
    }

    if (outcome.status !== "success") {
      this.agent.economics.record({ type: "task_failed", connector: strategy.connectorName });
      return { opportunity, outcome };
    }

    const submitApproval = this._checkApproval(strategy.submitPermission);
    if (submitApproval.needsApproval) {
      return { opportunity, outcome, submission: { status: "pending_human_approval", riskLevel: submitApproval.riskLevel } };
    }

    try {
      const submission = await this.agent.callConnector(
        strategy.connectorName,
        strategy.submitOperation,
        strategy.submitPermission,
        () => strategy.submit(this.agent.connectors.get(strategy.connectorName), opportunity.raw, outcome.output)
      );

      this.agent.economics.record({
        type: "task_completed",
        connector: strategy.connectorName,
        model: outcome.meta?.model,
        revenueUsd: opportunity.rewardUsd || 0,
        costUsd: opportunity.estimatedModelCostUsd || 0,
      });

      const learning = await this._shareLearning(strategy.connectorName, task, outcome);
      return { opportunity, outcome, submission, learning };
    } catch (err) {
      this.agent.economics.record({ type: "task_failed", connector: strategy.connectorName });
      return { opportunity, outcome, submissionError: err.message };
    }
  }
  /**
   * Molt Market's job lifecycle is bid-first: `runCycle()` above handles
   * discovering and bidding. This handles the OTHER half — once a bid you
   * placed earlier gets accepted, this checks your notifications, and for
   * each accepted job, actually produces the deliverable and submits it.
   * Split into its own method because "check for accepted work" happens on
   * a different cadence than "look for new jobs to bid on."
   */
  async deliverAcceptedMoltMarketJobs({ maxJobs = 1 } = {}) {
    const connectorName = "moltMarket";
    const discoverApproval = this._checkApproval("READ_PUBLIC_WEB");
    if (discoverApproval.needsApproval) {
      return { status: "pending_human_approval", stage: "check_notifications" };
    }

    const notificationData = await this.agent.callConnector(
      connectorName,
      "getMyNotifications",
      "READ_PUBLIC_WEB",
      () => this.agent.connectors.get(connectorName).getMyNotifications({ unreadOnly: true })
    );
    const notifications = notificationData.notifications || notificationData.results || notificationData || [];

    const acceptedJobIds = notifications
      .filter((n) => ["bid_accepted", "job_assigned", "bid.accepted"].includes(n.type || n.event))
      .map((n) => n.job_id || n.data?.job_id)
      .filter(Boolean);

    const results = [];
    for (const jobId of acceptedJobIds.slice(0, maxJobs)) {
      results.push(await this._deliverOneMoltMarketJob(connectorName, jobId));
    }

    return { status: "completed", notificationsChecked: notifications.length, acceptedJobsFound: acceptedJobIds.length, results };
  }

  async _deliverOneMoltMarketJob(connectorName, jobId) {
    const job = await this.agent.callConnector(connectorName, "getJob", "READ_PUBLIC_WEB", () =>
      this.agent.connectors.get(connectorName).getJob(jobId)
    );

    const task = {
      id: `moltmarket-deliver-${jobId}`,
      type: job.category || "documentProcessing",
      input: { spec: job.description, topic: job.title, content: job.description },
      untrustedContent: job.description,
      untrustedSource: "moltmarket-job-brief",
      sourceConnector: connectorName,
    };

    const outcome = await this.agent.processTask(task);
    if (outcome.status === "pending_human_approval") {
      return { jobId, outcome, submission: { status: "pending_human_approval", riskLevel: outcome.riskLevel } };
    }
    if (outcome.status !== "success") {
      this.agent.economics.record({ type: "task_failed", connector: connectorName });
      return { jobId, outcome };
    }

    const submitApproval = this._checkApproval("SUBMIT_TASK");
    if (submitApproval.needsApproval) {
      return { jobId, outcome, submission: { status: "pending_human_approval", riskLevel: submitApproval.riskLevel } };
    }

    try {
      const submission = await this.agent.callConnector(connectorName, "deliverWork", "SUBMIT_TASK", () =>
        this.agent.connectors.get(connectorName).deliverWork(jobId, { content: outcome.output })
      );
      this.agent.economics.record({
        type: "task_completed",
        connector: connectorName,
        model: outcome.meta?.model,
        revenueUsd: job.budget_usdc || 0,
        costUsd: 0,
      });
      const learning = await this._shareLearning(connectorName, task, outcome);
      return { jobId, outcome, submission, learning };
    } catch (err) {
      this.agent.economics.record({ type: "task_failed", connector: connectorName });
      return { jobId, outcome, submissionError: err.message };
    }
  }
}

module.exports = MarketplacePipeline;
