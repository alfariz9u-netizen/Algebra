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
// FIX (real production evidence, 2026-09-30): a 429 was being IGNORED for
// cooldown purposes — see the old comment below ("only update on success")
// — so once Colony's server-side limit was already tripped, every single
// subsequent attempt re-failed with 429 immediately, with zero backoff,
// forever, until the account's own window happened to roll over on its
// own. Real logs showed TWO 429s three seconds apart because of exactly
// this. Worse: the actual failure seen was `ADMIN_CAP_REACHED` — "limited
// to 1 post per hour" — a stricter, account-specific cap than the general
// ~10/60min this file assumed, so even the normal 6-minute cooldown is not
// long enough to safely resume after one of these. `_colonyBlockedUntil`
// tracks that separately from the normal cooldown.
let _colonyBlockedUntil = 0;
const COLONY_429_COOLDOWN_MS = Number(process.env.COLONY_429_COOLDOWN_MS || 65 * 60 * 1000); // 65 min: safe floor, used when the message can't be parsed

/**
 * FIX (live evidence, 2026-09-30): the account's real admin-imposed cap
 * changed messages between two observed deployments — "limited to 1
 * posts per hour" at one point, "limited to 5 posts per 24 hours" at
 * another (same wording family, different numbers: this appears to be a
 * live, operator-adjustable cap on Colony's side, not a fixed platform
 * constant). A single hardcoded cooldown can't stay correct against a
 * cap that changes. This parses "N posts per M hour(s)" directly out of
 * the real 429 message and backs off for a full period / N (average
 * safe spacing) + 10% margin, falling back to COLONY_429_COOLDOWN_MS
 * only when the message doesn't match this shape (e.g. a different
 * error entirely).
 */
function parseColonyCapCooldownMs(message) {
  const m = /limited this account to (\d+)\s+posts? per (\d+)\s*(hour|hours|day|days)/i.exec(message || "");
  if (!m) return COLONY_429_COOLDOWN_MS;
  const count = Number(m[1]);
  const periodUnits = Number(m[2]);
  const unitMs = /day/i.test(m[3]) ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  if (!count || !periodUnits) return COLONY_429_COOLDOWN_MS;
  const periodMs = periodUnits * unitMs;
  const safeSpacing = Math.ceil((periodMs / count) * 1.1); // average spacing + 10% margin
  return Math.max(safeSpacing, COLONY_429_COOLDOWN_MS); // never back off for LESS than the safe floor
}

class MarketplacePipeline {
  constructor(agent) {
    this.agent = agent;
    this.learning = agent.learning;
  }

  _checkApproval(permissionAction) {
    const needsApproval = riskEngine.requiresHumanApproval(permissionAction, this.agent.autonomyLevel);
    return { needsApproval, riskLevel: riskEngine.classify(permissionAction) };
  }

  /** Texts that identify a listing across re-posts (title/description fields vary by platform). */
  _listingText(opp) {
    const r = (opp && opp.raw) || {};
    return [r.title, r.name, r.summary, r.description, r.body, r.content, r.spec].filter((v) => typeof v === "string").join(" ").slice(0, 2000);
  }

  /** Never process this listing again — neither by id nor by content when it comes back with a new id. */
  _retire(strategy, opportunity, reason) {
    if (!this.learning) return;
    this.learning.markOpportunityDead(strategy.connectorName, opportunity.id, reason);
    this.learning.markContentSeen(strategy.connectorName, this._listingText(opportunity), opportunity.id);
  }

  /** Record what went wrong as a lesson so the next similar task is not drafted the same way (no LLM involved). */
  _learnFromFailure(strategy, task, reason) {
    if (!this.learning || !this.learning.addLocalLesson) return;
    // Content-free: only the task type, connector and failure reason (lessons are pasted into later prompts).
    this.learning.addLocalLesson({
      kind: "negative",
      taskType: task && task.type,
      connector: strategy.connectorName,
      text: `A ${(task && task.type) || "task"} from ${strategy.connectorName} failed: ${String(reason).slice(0, 200)}. Do not repeat the same approach; check the exact requirements first.`,
      importance: 6,
    });
  }

  async _shareLearning(connectorName, task, outcome) {
    if (this.agent.connectors.status("colony") !== "CONNECTED") {
      return { shared: false, reason: "colony not connected" };
    }

    // FIX: rate-limit Colony posts. Without this, a cycle with 2+ tasks
    // fires 2+ posts within seconds and trips the server's 10/60min cap
    // (429 RATE_LIMIT_CREATE_POST). Cooldown below keeps us under it.
    const now = Date.now();
    if (now < _colonyBlockedUntil) {
      const remaining = Math.round((_colonyBlockedUntil - now) / 1000);
      return { shared: false, reason: `colony post blocked after a rate-limit response (${remaining}s remaining)` };
    }
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
          // Metadata only. The deliverable belongs to the client/marketplace: its text used to be posted
          // verbatim (first 500 chars) to a PUBLIC feed.
          body: `Capability used: ${outcome.capability}. QA score: ${outcome.meta?.qaScore ?? "n/a"}. Deliverable length: ${String(outcome.output || "").length} characters.`,
          colony: "general",
          postType: "finding",
        })
      );

      // Only update the cooldown timestamp on SUCCESS — a failed post
      // shouldn't block the next attempt.
      _lastColonyPostAt = Date.now();
      return { shared: true };
    } catch (err) {
      // FIX: a 429 must engage a backoff — see the comment at the top of
      // this file. Any other error (network blip, auth issue) keeps the
      // original "don't block the next attempt" behavior, since those
      // aren't evidence the account is actually rate-limited.
      if (/\b429\b|ADMIN_CAP_REACHED|RATE_LIMIT/i.test(err.message)) {
        _colonyBlockedUntil = Date.now() + parseColonyCapCooldownMs(err.message);
      }
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

    // The brain decides — from REAL paid results — whether this connector deserves tokens this cycle.
    const brain = this.agent.brain;
    const plan = brain
      ? brain.planCycle(strategy, { maxOpportunities, minExpectedValue })
      : { run: true, maxOpportunities, minExpectedValue, realizationRate: 1, mode: "no_brain", reason: "" };
    if (!plan.run) return { status: "skipped_low_roi", stage: "plan", mode: plan.mode, reason: plan.reason };
    maxOpportunities = plan.maxOpportunities;
    minExpectedValue = plan.minExpectedValue;

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
    // One malformed listing used to reject Promise.all and fail the WHOLE connector every cycle, forever.
    // Each listing is scored on its own; a bad one is skipped (and counted), never fatal.
    const listings = Array.isArray(rawList) ? rawList : [];
    let malformed = 0;
    const scoredOrNull = await Promise.all(
      listings.map(async (raw) => {
        try {
          return normalizeOpportunity(await strategy.toOpportunity(raw), strategy.connectorName, raw);
        } catch (err) {
          malformed += 1;
          console.warn(`[pipeline:${strategy.connectorName}] skipping malformed listing ${raw && raw.id}: ${err.message}`);
          return null;
        }
      })
    );
    const opportunities = scoredOrNull.filter(Boolean);
    for (const opp of opportunities) {
      this.agent.economics.record({ type: "task_discovered", connector: strategy.connectorName });
      if (this.learning) opp.successProbability = this.learning.calibratedSuccessProbability(strategy.connectorName, opp.successProbability);
      if (brain) {
        opp.realizationRate = plan.realizationRate; // an advertised reward is a hope: discount by what this connector really pays
        if (!opp.estimatedModelCostUsd) opp.estimatedModelCostUsd = brain.avgCostUsd(strategy.connectorName);
      }
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

    // Same listing re-posted under a new id (or twice in one batch): never draft it again.
    const { fresh, duplicates } = this.learning
      ? this.learning.partitionDuplicateContent(strategy.connectorName, toProcess, (o) => this._listingText(o))
      : { fresh: toProcess, duplicates: [] };

    const results = [];
    for (const opp of fresh.slice(0, maxOpportunities)) {
      results.push(await this._processOpportunity(strategy, opp));
    }

    return {
      status: "completed",
      discovered: opportunities.length,
      accepted: accepted.length,
      rejected: rejected.length,
      skippedKnownDead: skipped.length,
      skippedDuplicateContent: duplicates.length,
      plan: { mode: plan.mode, maxOpportunities, realizationRate: plan.realizationRate },
      malformed,
      results,
    };
  }

  async _processOpportunity(strategy, opportunity) {
    this.agent.economics.record({ type: "task_accepted", connector: strategy.connectorName, expectedValueUsd: opportunity.expectedValue });

    let task;
    try {
      task = await strategy.toTask(opportunity.raw); // may be async (AgenC fetches the job spec)
    } catch (err) {
      this.agent.economics.record({ type: "task_failed", connector: strategy.connectorName });
      this._retire(strategy, opportunity, `toTask failed: ${err.message}`);
      return { opportunity, outcome: { status: "failed", reason: `toTask failed: ${err.message}` } };
    }
    // The task carries what the economics ledger needs. `deferEconomics` means: processTask() must NOT
    // record task_completed/task_failed itself — whoever actually SUBMITS records it, exactly once
    // (processTask + the pipeline both recording used to double-count every task's expected revenue).
    if (task.rewardUsd === undefined) task.rewardUsd = opportunity.rewardUsd || 0;
    if (!task.sourceConnector) task.sourceConnector = strategy.connectorName;
    task.deferEconomics = true;
    const outcome = await this.agent.processTask(task);

    if (outcome.status === "pending_human_approval") {
      this._retire(strategy, opportunity, "awaiting/resolved via human approval queue — never re-drafted once queued");
      return { opportunity, outcome, submission: { status: "pending_human_approval", riskLevel: outcome.riskLevel } };
    }

    if (outcome.status !== "success") {
      this.agent.economics.record({ type: "task_failed", taskId: task.id, connector: strategy.connectorName });
      this._retire(strategy, opportunity, `verification/QA failed: ${outcome.reason || "unknown"}`);
      this._learnFromFailure(strategy, task, outcome.reason || "verification/QA failed");
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
        // "Submitted" is not "won": a bid is only a win once the platform accepts it. Counting every
        // submission as a win pushed the calibrated success probability toward 0.99 and made the agent
        // over-confident. Bids count as an attempt now and as a win when acceptance is observed
        // (recordWin); direct deliveries (submitKind "delivery") are wins when delivered.
        this.learning.recordAttempt(strategy.connectorName, { won: strategy.submitKind === "delivery" });
        // Same listing next cycle? Never again: it used to be re-submitted every 30 minutes (spam, wasted
        // LLM calls, and a ban risk) for every strategy without its own memory.
        this._retire(strategy, opportunity, "submitted");
      }

      this.agent.economics.record({
        type: "task_completed",
        taskId: task.id,
        connector: strategy.connectorName,
        model: outcome.meta?.model,
        tokenUsage: outcome.meta?.tokenUsage || 0,
        revenueUsd: 0, // real money is recorded by recordPayment() only
        // A bid is an offer, not delivered work: only direct deliveries count as "owed to us".
        expectedRevenueUsd: strategy.submitKind === "delivery" ? opportunity.rewardUsd || 0 : 0,
        bidRewardUsd: strategy.submitKind === "delivery" ? undefined : opportunity.rewardUsd || 0,
        costUsd: outcome.meta?.costUsd ?? opportunity.estimatedModelCostUsd ?? 0,
      });

      const learning = await this._shareLearning(strategy.connectorName, task, outcome);
      return { opportunity, outcome, submission, learning };
    } catch (err) {
      this.agent.economics.record({ type: "task_failed", taskId: task.id, connector: strategy.connectorName });
      if (this.learning) {
        this.learning.recordAttempt(strategy.connectorName, { won: false });
        const failure = this.learning.recordFailure(strategy.connectorName, strategy.submitOperation, err);
        if (failure.perListing) this._retire(strategy, opportunity, err.message);
        if (failure.perListing) this._learnFromFailure(strategy, task, err.message);
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

    // The platform accepted our bid: THIS is a real win.
    if (this.learning && this.learning.recordWin) this.learning.recordWin(connectorName);

    const task = {
      id: `moltmarket-deliver-${jobId}`,
      deferEconomics: true,
      rewardUsd: job.budget_usdc || 0,
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
      this.agent.economics.record({ type: "task_failed", taskId: task.id, connector: connectorName });
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
      if (this.learning) this.learning.recordSuccess(connectorName, "deliverWork");
      this.agent.economics.record({
        type: "task_completed",
        taskId: task.id,
        connector: connectorName,
        model: outcome.meta?.model,
        tokenUsage: outcome.meta?.tokenUsage || 0,
        revenueUsd: 0,
        expectedRevenueUsd: job.budget_usdc || 0,
        costUsd: outcome.meta?.costUsd ?? 0,
      });
      const learning = await this._shareLearning(connectorName, task, outcome);
      return { jobId, outcome, submission, learning };
    } catch (err) {
      this.agent.economics.record({ type: "task_failed", taskId: task.id, connector: connectorName });
      if (this.learning) this.learning.recordFailure(connectorName, "deliverWork", err);
      return { jobId, outcome, submissionError: err.message };
    }
  }
}

// تصدير مزدوج لضمان التوافق مع جميع طرق الاستيراد
module.exports = MarketplacePipeline;
module.exports.MarketplacePipeline = MarketplacePipeline;
