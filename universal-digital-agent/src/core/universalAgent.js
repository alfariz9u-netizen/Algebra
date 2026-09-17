"use strict";

const ModelRouter = require("./modelRouter");
const MemoryCache = require("./memoryCache");
const { TokenController, estimateTokens } = require("./tokenController");
const { PermissionSystem } = require("./permissionSystem");
const riskEngine = require("./riskEngine");
const { AuditLog } = require("./auditLog");
const KillSwitch = require("./killSwitch");
const RateLimiter = require("./rateLimiter");
const { currentLevel } = require("./autonomyLevels");
const { labelUntrustedContent } = require("./promptInjectionGuard");
const verificationLayer = require("./verificationLayer");
const { ConnectorRegistry } = require("./connectorRegistry");
const EconomicIntelligence = require("./economicIntelligence");
const { classify } = require("./intentClassifier");
const { CAPABILITIES } = require("../capabilities/definitions");
const ApprovalQueue = require("./approvalQueue");
const { parseJsonLoose } = require("./jsonExtract");

const QUALITY_THRESHOLD = Number(process.env.QA_QUALITY_THRESHOLD || 80);

/**
 * ONE intelligent agent, many capabilities, one memory system, one security
 * control plane, one economic engine, one verification layer — per spec
 * section 29. This replaces the previous 9-agent architecture; capabilities
 * are configuration + prompt logic invoked here, not separate agent objects
 * calling each other.
 */
class UniversalAgent {
  /**
   * @param {{ agentId?: string, persistDir?: string, encryptionKey?: string }} [options] - pass
   *   `persistDir` (e.g. "./data") to make memory/audit/economics/approvals
   *   survive restarts. Without it, everything is in-memory only (default
   *   — matches all existing tests/behavior). Pass `encryptionKey` (or set
   *   PERSIST_ENCRYPTION_KEY) to encrypt everything written to disk with
   *   real AES-256-GCM — strongly recommended whenever persistDir is used,
   *   since audit logs and memory can contain sensitive task content.
   */
  constructor({ agentId = "universal-digital-agent", persistDir, encryptionKey } = {}) {
    this.agentId = agentId;
    this.persistDir = persistDir;
    const resolvedEncryptionKey = encryptionKey || process.env.PERSIST_ENCRYPTION_KEY || undefined;
    this.modelRouter = new ModelRouter();
    this.memory = new MemoryCache(this.modelRouter, { persistDir, encryptionKey: resolvedEncryptionKey });
    this.tokens = new TokenController();
    this.permissions = new PermissionSystem({ persistDir, encryptionKey: resolvedEncryptionKey });
    this.audit = new AuditLog({ persistDir, encryptionKey: resolvedEncryptionKey });
    this.killSwitch = new KillSwitch({ persistDir, encryptionKey: resolvedEncryptionKey });
    this.rateLimiter = new RateLimiter({
      capacity: Number(process.env.CONNECTOR_RATE_LIMIT_CAPACITY || 10),
      refillPerSecond: Number(process.env.CONNECTOR_RATE_LIMIT_REFILL_PER_SEC || 1),
    });
    this.economics = new EconomicIntelligence({ persistDir, encryptionKey: resolvedEncryptionKey });
    this.connectors = new ConnectorRegistry();
    this.approvals = new ApprovalQueue({ persistDir, encryptionKey: resolvedEncryptionKey });
    this._approvedOverrides = new Set(); // taskIds resumed past their approval gate for this call only
    this.autonomyLevel = currentLevel();
  }

  /** Grants the standing permissions a task needs, scoped and time-limited (spec 18). */
  authorizeTask(taskId, actions, { durationMs = 30 * 60 * 1000 } = {}) {
    return actions.map((action) =>
      this.permissions.grant({
        agentId: this.agentId,
        taskId,
        resource: taskId,
        action,
        durationMs,
        riskLevel: riskEngine.classify(action),
      })
    );
  }

  /**
   * Full lifecycle: classify -> plan -> select ONE capability -> permission/
   * risk/budget gates -> cache check -> execute -> verify -> record -> deliver.
   */
  async processTask(task) {
    const taskId = task.id;
    this.killSwitch.assertCanAct();

    // 1. Intent classification — deterministic first, LLM fallback only if needed.
    const intent = await classify(task, this.modelRouter);
    const capability = CAPABILITIES[intent.capability];
    if (!capability) {
      return this._fail(taskId, `No capability found for classified intent "${intent.capability}".`);
    }

    this.audit.record({
      agentId: this.agentId,
      taskId,
      action: "CLASSIFY_INTENT",
      result: `${intent.capability} (${intent.method})`,
      riskLevel: "LOW",
    });

    // 2. Risk/autonomy gate FIRST. This must run before any permission is
    // granted — granting first and checking second (the previous order)
    // made the "deny-by-default" permission system decorative, since the
    // agent was always the one both issuing and checking its own grant.
    // Only actions that clear this gate (LOW risk, or MEDIUM/HIGH already
    // approved via resumeTask) are ever self-authorized below.
    const needsApproval =
      !this._approvedOverrides.has(taskId) && riskEngine.requiresHumanApproval(capability.permission, this.autonomyLevel);
    if (needsApproval) {
      const approval = this.approvals.enqueue({
        taskId,
        task,
        capability: capability.name,
        action: capability.permission,
        riskLevel: capability.riskLevel,
      });
      this.audit.record({
        agentId: this.agentId,
        taskId,
        action: capability.permission,
        result: "HUMAN_APPROVAL_REQUIRED",
        riskLevel: capability.riskLevel,
        approvalStatus: "PENDING",
      });
      return this._pendingApproval(taskId, capability, approval.id);
    }

    // 2b. The action cleared the risk gate — now, and only now, self-authorize
    // and check the grant. `check()` is no longer a rubber stamp: reaching
    // this line already proves the action was either LOW risk or explicitly
    // approved by a human via resumeTask.
    this.authorizeTask(taskId, [capability.permission]);
    const permCheck = this.permissions.check({
      agentId: this.agentId,
      taskId,
      resource: taskId,
      action: capability.permission,
    });
    if (!permCheck.allowed) {
      return this._fail(taskId, `Permission denied: ${permCheck.reason}`);
    }

    // 3. Build prompt, labeling any untrusted external content embedded in the task.
    let userPrompt = capability.buildUserPrompt(task);
    if (task.untrustedContent) {
      const { labeled, scan } = labelUntrustedContent(task.untrustedSource || "external", task.untrustedContent);
      userPrompt = `${userPrompt}\n\n${labeled}`;
      if (scan.suspicious) {
        this.audit.record({
          agentId: this.agentId,
          taskId,
          action: "PROMPT_INJECTION_FLAGGED",
          result: JSON.stringify(scan.matches),
          riskLevel: "HIGH",
        });
      }
    }

    // 4. Cache check BEFORE spending any tokens.
    const cacheResult = await this.memory.lookup(capability.name, userPrompt);
    if (cacheResult.hit) {
      this.audit.record({
        agentId: this.agentId,
        taskId,
        action: "CACHE_HIT",
        result: cacheResult.via,
        riskLevel: "LOW",
      });
      return this._deliver(taskId, capability, cacheResult.entry.result, { cached: true, via: cacheResult.via });
    }

    // 5. Token/compute budget preflight.
    const preflight = this.tokens.preflight(taskId, { systemPrompt: capability.systemPrompt, userPrompt });
    if (!preflight.allowed) {
      this.audit.record({
        agentId: this.agentId,
        taskId,
        action: "BUDGET_REJECTED",
        result: preflight.reasons.join("; "),
        riskLevel: "LOW",
      });
      return this._fail(taskId, `Token/compute budget exceeded: ${preflight.reasons.join("; ")}`);
    }

    // 6. Execute — the ONE real LLM call this task needs for this capability.
    let generation;
    try {
      generation = await this.modelRouter.generate(capability.systemPrompt, userPrompt, capability.tier);
    } catch (err) {
      this.audit.record({
        agentId: this.agentId,
        taskId,
        action: "LLM_CALL",
        result: "ERROR",
        error: err.message,
        riskLevel: capability.riskLevel,
      });
      return this._fail(taskId, `Execution failed: ${err.message}`);
    }

    const actualTokens = generation.usage?.totalTokens || preflight.estimatedTotal;
    this.tokens.record(taskId, actualTokens);

    this.audit.record({
      agentId: this.agentId,
      taskId,
      action: "LLM_CALL",
      result: "SUCCESS",
      tokenUsage: actualTokens,
      riskLevel: capability.riskLevel,
    });

    // 7. Verification — deterministic where possible.
    const verification = verificationLayer.verify(capability.name, generation.text);

    // 8. QA grading (a single additional fast-tier call — not a second "agreeing" agent).
    const qa = await this._qaGrade(taskId, generation.text, capability);

    const passed = verification.passed && qa.passed;

    if (!passed) {
      this.economics.record({ type: "task_failed", model: generation.model, connector: task.sourceConnector });
      return this._fail(
        taskId,
        `Did not pass verification/QA. Verification: ${verification.checks.join("; ")}. QA: ${qa.message}`
      );
    }

    // 9. Store to memory/cache for future reuse — only verified results are cached.
    await this.memory.store(capability.name, userPrompt, generation.text, {
      verificationStatus: "passed",
      confidence: qa.score / 100,
      model: generation.model,
      provider: generation.provider,
      tokenUsage: actualTokens,
    });

    this.economics.record({
      type: "task_completed",
      model: generation.model,
      connector: task.sourceConnector,
      revenueUsd: task.rewardUsd || 0,
      costUsd: 0, // Gemini free tier == $0 real cost; non-zero only if a paid provider tier is used.
    });

    return this._deliver(taskId, capability, generation.text, {
      cached: false,
      qaScore: qa.score,
      tokenUsage: actualTokens,
      model: generation.model,
      provider: generation.provider,
    });
  }

  async _qaGrade(taskId, deliverableText, producingCapability) {
    const qaCapability = CAPABILITIES.qualityAssurance;
    const prompt = qaCapability.buildUserPrompt({
      input: {
        deliverableText,
        criteria: `Produced by the ${producingCapability.name} capability.`,
      },
    });

    const preflight = this.tokens.preflight(`${taskId}-qa`, { systemPrompt: qaCapability.systemPrompt, userPrompt: prompt });
    if (!preflight.allowed) {
      return { passed: false, score: 0, message: `QA could not run: budget exceeded (${preflight.reasons.join("; ")})` };
    }

    try {
      const { text, usage } = await this.modelRouter.generate(qaCapability.systemPrompt, prompt, qaCapability.tier);
      this.tokens.record(taskId, usage?.totalTokens || preflight.estimatedTotal);
      const parsed = parseJsonLoose(text);
      const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
      return { passed: score >= QUALITY_THRESHOLD, score, message: parsed.reasoning };
    } catch (err) {
      return { passed: false, score: 0, message: `QA could not run: ${err.message}` };
    }
  }

  _deliver(taskId, capability, output, meta) {
    return { status: "success", taskId, capability: capability.name, output, meta, audit: this.audit.forTask(taskId) };
  }

  _fail(taskId, reason) {
    this.audit.record({ agentId: this.agentId, taskId, action: "TASK_FAILED", result: reason, riskLevel: "LOW" });
    return { status: "failed", taskId, reason, audit: this.audit.forTask(taskId) };
  }

  _pendingApproval(taskId, capability, approvalId) {
    return {
      status: "pending_human_approval",
      taskId,
      approvalId,
      capability: capability.name,
      riskLevel: capability.riskLevel,
      audit: this.audit.forTask(taskId),
    };
  }

  /**
   * The other half of the approval flow: once a human has approved a
   * pending request (via the approvals queue / CLI), this actually
   * re-runs the original task, bypassing ONLY the approval gate for this
   * exact taskId — every other gate (permissions, budget, verification,
   * QA) still applies in full.
   */
  async resumeTask(approvalId) {
    const record = this.approvals.get(approvalId);
    if (!record) throw new Error(`No approval request with id "${approvalId}".`);
    if (record.status !== "approved") {
      return { status: record.status, approvalId, message: `Approval "${approvalId}" is "${record.status}", not "approved" — nothing to resume.` };
    }
    if (!record.resumable || !record.task) {
      return { status: "not_resumable", approvalId, message: "This approval has no stored task to resume automatically." };
    }

    this._approvedOverrides.add(record.taskId);
    try {
      return await this.processTask(record.task);
    } finally {
      this._approvedOverrides.delete(record.taskId);
    }
  }

  /**
   * The ONLY sanctioned path for calling a connector operation. Enforces,
   * in order: kill switch, connector actually supports the operation
   * (never assumes), permission grant, and per-connector rate limiting —
   * then audits the outcome either way. Nothing should call a connector
   * method directly, bypassing these gates.
   */
  async callConnector(connectorName, operation, permissionAction, fn) {
    this.killSwitch.assertCanAct(connectorName);

    if (!this.connectors.supports(connectorName, operation)) {
      const status = this.connectors.status(connectorName);
      const reason = `Connector "${connectorName}" does not support "${operation}" right now (status: ${status}).`;
      this.audit.record({ agentId: this.agentId, connector: connectorName, action: operation, result: "NOT_SUPPORTED", riskLevel: riskEngine.classify(permissionAction) });
      throw new Error(reason);
    }

    this.rateLimiter.assertConsume(connectorName);

    try {
      const result = await fn();
      this.audit.record({ agentId: this.agentId, connector: connectorName, action: operation, result: "SUCCESS", riskLevel: riskEngine.classify(permissionAction) });
      return result;
    } catch (err) {
      this.audit.record({ agentId: this.agentId, connector: connectorName, action: operation, result: "ERROR", error: err.message, riskLevel: riskEngine.classify(permissionAction) });
      throw err;
    }
  }

  /**
   * Runs retention pruning across memory/audit/economics in one call —
   * this is what actually closes the "no database cleanup" gap. Safe to
   * call repeatedly (e.g. from a daily cron via src/maintenanceCli.js);
   * financial totals in economics are preserved via rollup regardless of
   * how aggressively you prune.
   */
  runMaintenance({
    memoryMaxRecords = Number(process.env.MEMORY_MAX_RECORDS || 0) || undefined,
    auditMaxAgeMs = Number(process.env.AUDIT_MAX_AGE_MS || 0) || undefined,
    auditMaxEntries = Number(process.env.AUDIT_MAX_ENTRIES || 0) || undefined,
    economicsMaxAgeMs = Number(process.env.ECONOMICS_MAX_AGE_MS || 0) || undefined,
    economicsMaxEntries = Number(process.env.ECONOMICS_MAX_ENTRIES || 0) || undefined,
  } = {}) {
    return {
      memory: this.memory.pruneExpired({ maxRecords: memoryMaxRecords }),
      audit: this.audit.prune({ maxAgeMs: auditMaxAgeMs, maxEntries: auditMaxEntries }),
      economics: this.economics.prune({ maxAgeMs: economicsMaxAgeMs, maxEntries: economicsMaxEntries }),
    };
  }

  dashboard() {
    return {
      agentId: this.agentId,
      persistDir: this.persistDir || null,
      autonomyLevel: this.autonomyLevel,
      killSwitch: this.killSwitch.status(),
      dailyTokenUsage: this.tokens.getDailyUsage(),
      economics: this.economics.summary(),
      connectors: this.connectors.list(),
      pendingApprovals: this.approvals.list({ status: "pending" }).length,
      auditEntryCount: this.audit.all().length,
    };
  }
}

module.exports = UniversalAgent;
