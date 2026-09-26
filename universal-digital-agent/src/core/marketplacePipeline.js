"use strict";

const { normalizeOpportunity, rankOpportunities } = require("./opportunityEngine");
const riskEngine = require("./riskEngine");

class MarketplacePipeline {
  constructor(agent) {
    this.agent = agent;
    this.learning = agent.learning;
  }

  _checkApproval(permissionAction) {
    const needsApproval = riskEngine.requiresHumanApproval(permissionAction, this.agent.autonomyLevel);
    return { needsApproval, riskLevel: riskEngine.classify(permissionAction) };
  }

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

  async runCycle(strategy, { minExpectedValue = 0, maxOpportunities = 1 } = {}) {
    const discoverApproval = this._checkApproval(strategy.discoverPermission);
    if (discoverApproval.needsApproval) {
      return { status: "pending_human_approval", stage: "discover", riskLevel: discoverApproval.riskLevel };
    }

    const discoverGate = this.learning ? this.learning.checkCircuit(strategy.connectorName, strategy.discoverOperation) : { open: false };
    if (discoverGate.open) {
      return { status: "skipped_circuit_open", stage: "discover", ...discoverGate };
    }
    const submitGate = this.learning ? this.learning.checkCircuit(strategy.connectorName, strategy.submitOperation) : { open: false };
    if (submitGate.open) {
      return { status: "skipped_circuit_open", stage: "submit", ...submitGate };
    }

    let rawList;
    try {
      rawList = await this.agent.callConnector(
        strategy.connectorName,
        strategy.discoverOperation,
        strategy.discoverPermission,
        () => strategy.discover(this.agent.connectors.get(strategy.connectorName))
      );
      if (this.learning) this.learning.recordSuccess(strategy.connectorName, strategy.discoverOperation);
    } catch (err) {
      if (this.learning) this.learning.recordFailure(strategy.connectorName, strategy.discoverOperation, err);
      throw err;
    }

    const opportunities = await Promise.all(
      rawList.map(async (raw) => normalizeOpportunity(await strategy.toOpportunity(raw), strategy.connectorName))
    );
    for (const opp of opportunities) {
      this.agent.economics.record({ type: "task_discovered", connector: strategy.connectorName });
      if (this.learning) opp.successProbability = this.learning.calibratedSuccessProbability(strategy.connectorName, opp.successProbability);
    }

    const { accepted, rejected } = rankOpportunities(opportunities, { minExpectedValue });
    for (const opp of rejected) {
      this.agent.economics.record({
        type: "task_rejected",
        connector: strategy.connectorName,
        expectedValueUsd: opp.expectedValue,
        reason: opp.rejectionReason,
      });
    }

    const { toProcess, skipped } = this.learning
      ? this.learning.partitionKnownDead(strategy.connectorName, accepted)
      : { toProcess: accepted, skipped: [] };

    const results = [];
    for (const opp of toProcess.slice(0, maxOpportunities)) {
      results.push(await this._processOpportunity(strategy, opp));
    }

    return {
      status: "completed",
      discovered: opportunities.length,
      accepted: accepted.length,
      rejected: rejected.length,
      skippedKnownDead: skipped.length,
      results,
    };
  }

  async _processOpportunity(strategy, opportunity) {
    this.agent.economics.record({ type: "task_accepted", connector: strategy.connectorName, expectedValueUsd: opportunity.expectedValue });

    const task = strategy.toTask(opportunity.raw);
    const outcome = await this.agent.processTask(task);

    if (outcome.status === "pending_human_approval") {
      if (this.learning) this.learning.markOpportunityDead(strategy.connectorName, opportunity.id, "awaiting/resolved via human approval queue — never re-drafted once queued");
      return { opportunity, outcome, submission: { status: "pending_human_approval", riskLevel: outcome.riskLevel } };
    }

    if (outcome.status !== "success") {
      this.agent.economics.record({ type: "task_failed", connector: strategy.connectorName });
      if (this.learning) this.learning.markOpportunityDead(strategy.connectorName, opportunity.id, `verification/QA failed: ${outcome.reason || "unknown"}`);
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
      if (this.learning) {
        this.learning.recordSuccess(strategy.connectorName, strategy.submitOperation);
        this.learning.recordAttempt(strategy.connectorName, { won: true });
      }

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
      if (this.learning) {
        this.learning.recordAttempt(strategy.connectorName, { won: false });
        const failure = this.learning.recordFailure(strategy.connectorName, strategy.submitOperation, err);
        if (failure.perListing) this.learning.markOpportunityDead(strategy.connectorName, opportunity.id, err.message);
      }
      return { opportunity, outcome, submissionError: err.message };
    }
  }

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
      if (this.learning) {
        this.learning.recordSuccess(connectorName, "deliverWork");
        this.learning.recordAttempt(connectorName, { won: true });
      }
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
      if (this.learning) this.learning.recordFailure(connectorName, "deliverWork", err);
      return { jobId, outcome, submissionError: err.message };
    }
  }
}

// تصدير مزدوج لضمان التوافق مع جميع طرق الاستيراد
module.exports = MarketplacePipeline;
module.exports.MarketplacePipeline = MarketplacePipeline;
