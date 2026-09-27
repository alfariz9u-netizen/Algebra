"use strict";

const { normalizeOpportunity, rankOpportunities } = require("./opportunityEngine");
const riskEngine = require("./riskEngine");

/**
 * The Colony enforces "max 10 create posts per 60 minutes" (429
 * RATE_LIMIT_CREATE_POST). The pipeline calls _shareLearning() after
 * every successful task, so a single cycle with multiple tasks can fire
 * several posts within seconds and trip the limit — which is what we saw
 * in production (two 429s in a row, retry_after=475s).
 *
 * The cooldown below spaces Colony posts out to stay safely under that
 * cap. Default 6 minutes → at most 10 posts per 60 minutes. Override via
 * COLONY_POST_COOLDOWN_MS if the platform's window changes.
 */
let _lastColonyPostAt = 0;
const COLONY_POST_COOLDOWN_MS = Number(process.env.COLONY_POST_COOLDOWN_MS || 6 * 60 * 1000);

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
    if (this.agent.connectors.status("colony") !== "CONNECTED") {
      return { shared: false, reason: "colony not connected" };
    }

    // FIX: rate-limit Colony posts. Without this, a cycle with 2+ tasks
    // fires 2+ posts within seconds and trips the server's 10/60min cap
    // (429 RATE_LIMIT_CREATE_POST). Cooldown below keeps us under it.
    const now = Date.now();
    if (now - _lastColonyPostAt < COLONY_POST_COOLDOWN_MS) {
      const remaining = Math.round((COLONY_POST_COOLDOWN_MS - (now - _lastColonyPostAt)) / 1000);
      return { shared: false, reason: `colony post cooldown (${remaining}s remaining)` };
    }

    const approval = this._checkApproval("PUBLISH");
    if (approval.needsApproval) {
      return { shared: false, reason: "PUBLISH requires human approval at current autonomy level" };
    }

    try {
      // Unique title (last 8 chars of task id + HH:MM:SS) so The Colony's
      // 30-day duplicate-title guard doesn't reject it. The previous title
      // was always "Completed a {type} task sourced from {connector}" —
      // identical for every task of the same type+connector.
      const uniqueSuffix = `${String(task.id || "x").slice(-8)} · ${new Date().toISOString().slice(11, 19)}`;
      const title = `Completed a ${task.type} task sourced from ${connectorName} — ${uniqueSuffix}`;

      await this.agent.callConnector("colony", "postFinding", "PUBLISH", () =>
        this.agent.connectors.get("colony").postFinding({
          title,
          body: `Capability used: ${outcome.capability}. QA score: ${outcome.meta?.qaScore ?? "n/a"}. Result summary: ${String(outcome.output || "").slice(0, 500)}`,
          colony: "general",
          postType: "finding",
        })
      );

      // Only update the cooldown timestamp on SUCCESS — a failed post
      // shouldn't block the next attempt.
      _lastColonyPostAt = Date.now();
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

    // FIX: pass the ORIGINAL discovered listing as the third argument to
    // normalizeOpportunity(). Without it, `opportunity.raw` becomes the
    // scoring summary and every strategy's toTask()/submit() downstream
    // loses the real listing fields (title, body, repository_url, number,
    // budget, ...).
    const opportunities = await Promise.all(
      rawList.map(async (raw) =>
        normalizeOpportunity(await strategy.toOpportunity(raw), strategy.connectorName, raw)
      )
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
