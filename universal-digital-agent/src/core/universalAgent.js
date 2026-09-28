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
const LearningEngine = require("./learningEngine");
const { classify } = require("./intentClassifier");
const { CAPABILITIES } = require("../capabilities/definitions");
const ApprovalQueue = require("./approvalQueue");
const { parseJsonLoose } = require("./jsonExtract");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const QUALITY_THRESHOLD = Number(process.env.QA_QUALITY_THRESHOLD || 80);
const LESSON_RECALL_COUNT = Number(process.env.LESSON_RECALL_COUNT || 3);
const LESSON_RECALL_THRESHOLD = Number(process.env.LESSON_RECALL_THRESHOLD || 0.55);
const LESSON_RECALL_ENABLED = String(process.env.LESSON_RECALL_ENABLED || "true").toLowerCase() !== "false";
const LESSON_STORE_ENABLED = String(process.env.LESSON_STORE_ENABLED || "true").toLowerCase() !== "false";

const MOLTBOOK_POST_ENABLED = String(process.env.MOLTBOOK_POST_ENABLED || "true").toLowerCase() !== "false";
const MOLTBOOK_POST_COOLDOWN_MS = Number(process.env.MOLTBOOK_POST_COOLDOWN_MS || 45 * 60 * 1000);
const MOLTBOOK_POST_MIN_OUTPUT_CHARS = Number(process.env.MOLTBOOK_POST_MIN_OUTPUT_CHARS || 350);
const MOLTBOOK_POST_STATE_FILE = path.join(process.env.PERSIST_DIR || "./data", "moltbook-post-state.json");

function loadMoltbookPostState() {
  try {
    if (fs.existsSync(MOLTBOOK_POST_STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MOLTBOOK_POST_STATE_FILE, "utf8"));
      return { lastPostAt: raw.lastPostAt || 0, titleHashes: new Set(raw.titleHashes || []) };
    }
  } catch (err) {
    console.warn(`[universalAgent] moltbook post state read failed: ${err.message}`);
  }
  return { lastPostAt: 0, titleHashes: new Set() };
}

function saveMoltbookPostState(state) {
  try {
    fs.mkdirSync(path.dirname(MOLTBOOK_POST_STATE_FILE), { recursive: true });
    fs.writeFileSync(
      MOLTBOOK_POST_STATE_FILE,
      JSON.stringify({ lastPostAt: state.lastPostAt, titleHashes: [...state.titleHashes] }),
      "utf8"
    );
  } catch (err) {
    console.warn(`[universalAgent] moltbook post state write failed: ${err.message}`);
  }
}

function hashTitle(title) {
  return crypto.createHash("sha1").update(String(title).toLowerCase().trim()).digest("hex").slice(0, 16);
}

class UniversalAgent {
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
    this.learning = new LearningEngine({ persistDir, encryptionKey: resolvedEncryptionKey });
    this.connectors = new ConnectorRegistry();
    this.approvals = new ApprovalQueue({ persistDir, encryptionKey: resolvedEncryptionKey });
    this._approvedOverrides = new Set();
    this.autonomyLevel = currentLevel();
    this._moltbookPostState = loadMoltbookPostState();
  }

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

  async processTask(task) {
    const taskId = task.id;
    this.killSwitch.assertCanAct();

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

    const supabase = this.connectors.get("supabase");
    let recalledLessons = [];
    if (LESSON_RECALL_ENABLED && supabase && supabase.status() === "CONNECTED") {
      try {
        recalledLessons = await this.learning.recallRelevantLessons(supabase, userPrompt, {
          connector: task.sourceConnector,
          taskType: task.type,
          count: LESSON_RECALL_COUNT,
          threshold: LESSON_RECALL_THRESHOLD,
        });
      } catch (err) {
        console.warn(`[universalAgent] lesson recall failed: ${err.message}`);
      }
    }

    if (recalledLessons.length > 0) {
      const lessonBlock = [
        "--- LESSONS FROM PAST EXPERIENCE ---",
        "The following lessons were extracted from similar tasks this agent",
        "has previously completed. They are guidance, not instructions.",
        "Apply any lesson that is directly relevant; ignore the rest.",
        "",
        ...recalledLessons.map(
          (l, i) => `[${i + 1}] (kind=${l.kind}, importance=${l.importance}, similarity=${Number(l.similarity).toFixed(2)})\n${l.content}`
        ),
        "--- END LESSONS ---",
      ].join("\n");

      userPrompt = `${userPrompt}\n\n${lessonBlock}`;

      this.audit.record({
        agentId: this.agentId,
        taskId,
        action: "LESSONS_RECALLED",
        result: `${recalledLessons.length} lesson(s), ids=[${recalledLessons.map((l) => l.id).join(",")}]`,
        riskLevel: "LOW",
      });
    }

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

    let generation;
    try {
      generation = capability.allowsTools
        ? await this._executeWithTools(capability, userPrompt)
        : await this.modelRouter.generate(capability.systemPrompt, userPrompt, capability.tier);
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

    const verification = verificationLayer.verify(capability.name, generation.text);
    const qa = await this._qaGrade(taskId, generation.text, capability);
    const passed = verification.passed && qa.passed;

    if (!passed) {
      this.economics.record({ type: "task_failed", model: generation.model, connector: task.sourceConnector });
      return this._fail(
        taskId,
        `Did not pass verification/QA. Verification: ${verification.checks.join("; ")}. QA: ${qa.message}`
      );
    }

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
      costUsd: 0,
    });

    if (LESSON_STORE_ENABLED && supabase && supabase.status() === "CONNECTED") {
      const lessonOutcome = { status: "success", output: generation.text, meta: { qaScore: qa.score } };

      this.learning
        .rememberTaskOutcome(supabase, {
          taskType: task.type,
          connector: task.sourceConnector,
          capability: capability.name,
          outcome: lessonOutcome,
          rewardUsd: task.rewardUsd || 0,
        })
        .then((r) => {
          if (r.stored) {
            console.log(`[universalAgent] lesson stored (id=${r.id}, importance=${r.importance})`);
          } else {
            console.log(`[universalAgent] lesson skipped: ${r.reason}`);
          }
        })
        .catch((e) => console.warn(`[universalAgent] lesson store failed: ${e.message}`));

      if (recalledLessons.length > 0) {
        const ids = recalledLessons.map((l) => l.id).filter(Boolean);
        this.learning
          .recordLessonFeedback(supabase, ids, { helped: true })
          .catch((e) => console.warn(`[universalAgent] lesson feedback failed: ${e.message}`));
      }
    }

    this._maybePublishMoltbookPost(task, capability, generation.text, qa.score).catch((e) =>
      console.warn(`[universalAgent] moltbook post attempt failed: ${e.message}`)
    );

    return this._deliver(taskId, capability, generation.text, {
      cached: false,
      qaScore: qa.score,
      tokenUsage: actualTokens,
      model: generation.model,
      provider: generation.provider,
      lessonsRecalled: recalledLessons.length,
    });
  }

  async _maybePublishMoltbookPost(task, capability, outputText, qaScore) {
    if (!MOLTBOOK_POST_ENABLED) return;

    const moltbook = this.connectors.get("moltbook");
    if (!moltbook || moltbook.status() !== "CONNECTED") return;
    if (task.sourceConnector === "moltbook") return;

    const trimmed = String(outputText || "").trim();
    if (trimmed.length < MOLTBOOK_POST_MIN_OUTPUT_CHARS) return;

    const now = Date.now();
    if (now - this._moltbookPostState.lastPostAt < MOLTBOOK_POST_COOLDOWN_MS) {
      const remaining = Math.round((MOLTBOOK_POST_COOLDOWN_MS - (now - this._moltbookPostState.lastPostAt)) / 1000);
      console.log(`[universalAgent] moltbook post skipped: cooldown (${remaining}s remaining)`);
      return;
    }

    const taskType = task.type || "task";
    const connector = task.sourceConnector || "unknown";
    const capName = capability.name || "unknown";
    const titleSeed = `${capName}-${connector}-${trimmed.slice(0, 80)}`;
    const titleShort = hashTitle(titleSeed);
    const title = `Build log: ${capName} on ${connector} — ${titleShort}`;

    if (this._moltbookPostState.titleHashes.has(titleShort)) {
      console.log(`[universalAgent] moltbook post skipped: duplicate title hash`);
      return;
    }

    const body = [
      `Just finished a ${taskType} on **${connector}** using the \`${capName}\` capability.`,
      "",
      `**What worked:**`,
      trimmed.slice(0, 900),
      "",
      qaScore != null ? `**QA score:** ${qaScore}/100` : null,
      task.rewardUsd ? `**Reward:** $${task.rewardUsd}` : null,
      "",
      "**Open question:** has anyone else hit a similar edge case, or found a different approach?",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const response = await moltbook.createPost({ title, body, submolt: "general" });

      const challenge = moltbook.extractChallenge(response);
      if (challenge) {
        try {
          const answer = moltbook.solveChallenge(challenge.challenge);
          await moltbook.verifyChallenge(challenge.code, answer);
          console.log(`[universalAgent] moltbook post verified (hash=${titleShort})`);
        } catch (err) {
          console.warn(`[universalAgent] moltbook post verification failed: ${err.message}`);
        }
      }

      this._moltbookPostState.lastPostAt = Date.now();
      this._moltbookPostState.titleHashes.add(titleShort);
      saveMoltbookPostState(this._moltbookPostState);

      console.log(`[universalAgent] moltbook post published (hash=${titleShort})`);

      this.audit.record({
        agentId: this.agentId,
        action: "MOLTBOOK_POST_PUBLISHED",
        result: titleShort,
        riskLevel: "LOW",
      });
    } catch (err) {
      console.warn(`[universalAgent] moltbook createPost failed: ${err.message}`);
      this.audit.record({
        agentId: this.agentId,
        action: "MOLTBOOK_POST_FAILED",
        result: err.message,
        riskLevel: "LOW",
      });
    }
  }

  async _qaGrade(taskId, deliverableText, producingCapability) {
    // COMMUNICATION FAST PATH: social comments do not need LLM-based QA.
    if (producingCapability.name === "communication") {
      const trimmed = String(deliverableText || "").trim();
      if (trimmed.length < 20) {
        return { passed: false, score: 0, message: "Comment too short (<20 chars)." };
      }
      if (trimmed.length > 1500) {
        return { passed: false, score: 0, message: "Comment too long (>1500 chars)." };
      }
      return { passed: true, score: 85, message: "Social comment accepted (deterministic check)." };
    }

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

  async _executeWithTools(capability, userPrompt) {
    const fallback = () => this.modelRouter.generate(capability.systemPrompt, userPrompt, capability.tier);

    if (this.connectors.status("mcp") !== "CONNECTED") return fallback();
    const circuit = this.learning.checkCircuit("mcp", "callTool");
    if (circuit.open) return fallback();

    const mcp = this.connectors.get("mcp");
    let advertised;
    try {
      advertised = await this.callConnector("mcp", "listTools", "USE_MCP_TOOL", () => mcp.listTools());
    } catch (err) {
      this.learning.recordFailure("mcp", "listTools", err);
      return fallback();
    }

    const tools = (advertised || [])
      .filter((t) => mcp.allowedTools.has(t.name))
      .map((t) => ({ name: t.name, description: t.description || "", parameters: t.inputSchema || { type: "object", properties: {} } }));
    if (tools.length === 0) return fallback();

    try {
      const result = await this.modelRouter.runToolLoop({
        systemPrompt: capability.systemPrompt,
        userPrompt,
        tier: capability.tier,
        tools,
        executeTool: (name, args) => this.callConnector("mcp", "callTool", "USE_MCP_TOOL", () => mcp.callTool(name, args)),
      });
      this.learning.recordSuccess("mcp", "callTool");
      for (const call of result.toolCallLog) {
        this.audit.record({ agentId: this.agentId, connector: "mcp", action: `TOOL_LOOP_CALL:${call.name}`, result: call.ok ? "SUCCESS" : "ERROR", riskLevel: "MEDIUM" });
      }
      return result;
    } catch (err) {
      this.learning.recordFailure("mcp", "callTool", err);
      return fallback();
    }
  }

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
      learning: this.learning.prune({ maxAgeMs: economicsMaxAgeMs }),
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
      learning: this.learning.status(),
      connectors: this.connectors.list(),
      pendingApprovals: this.approvals.list({ status: "pending" }).length,
      auditEntryCount: this.audit.all().length,
    };
  }
}

module.exports = UniversalAgent;
