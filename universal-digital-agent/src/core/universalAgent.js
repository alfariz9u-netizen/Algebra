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
const { estimateCostUsd, DailyQuotaTracker } = require("./llmPricing");
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
// FIX: was a hardcoded 45-minute default, while core/strategies/moltbook.js
// reads the SAME env var (MOLTBOOK_POST_COOLDOWN_MS) with a 30-minute
// default. Two independent callers hitting Moltbook's real "1 post per 30
// min" limit with two different cooldown lengths — and, worse, two
// separate state files (see below) — meant neither actually knew about the
// other's last post. Aligned to 30 minutes here so an unset env var can't
// silently desynchronize the two.
const MOLTBOOK_POST_COOLDOWN_MS = Number(process.env.MOLTBOOK_POST_COOLDOWN_MS || 30 * 60 * 1000);
const MOLTBOOK_POST_MIN_OUTPUT_CHARS = Number(process.env.MOLTBOOK_POST_MIN_OUTPUT_CHARS || 350);
// FIX: this used to be its own file (moltbook-post-state.json), completely
// separate from core/strategies/moltbook.js's moltbook-state.json. Both
// files tracked "last time we posted" independently, so this auto-post
// hook and the scheduled reputation strategy could each think Moltbook's
// real rate limit had reset when it hadn't — risking a real 429 from
// Moltbook (and, repeated enough, account suspension per moltbook.js's own
// "10-strike" note). Now both read/write the SAME file and the SAME
// lastPostAt/publishedTitleHashes fields, so whichever of the two posts
// last is the one the other respects. Merge-safe: only the post-related
// fields are touched here; the strategy's own comment/upvote bookkeeping
// in the same file is read back and preserved untouched.
const MOLTBOOK_STATE_FILE = path.join(process.env.PERSIST_DIR || "./data", "moltbook-state.json");

function loadMoltbookPostState() {
  try {
    if (fs.existsSync(MOLTBOOK_STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MOLTBOOK_STATE_FILE, "utf8"));
      return { lastPostAt: raw.lastPostAt || 0, titleHashes: new Set(raw.publishedTitleHashes || []) };
    }
  } catch (err) {
    console.warn(`[universalAgent] moltbook post state read failed: ${err.message}`);
  }
  return { lastPostAt: 0, titleHashes: new Set() };
}

function saveMoltbookPostState(state) {
  try {
    fs.mkdirSync(path.dirname(MOLTBOOK_STATE_FILE), { recursive: true });
    // Read-merge-write: preserve whatever core/strategies/moltbook.js has
    // already written for comments/upvotes (and vice versa) rather than
    // clobbering the shared file with only this hook's two fields.
    let existing = {};
    try {
      if (fs.existsSync(MOLTBOOK_STATE_FILE)) {
        existing = JSON.parse(fs.readFileSync(MOLTBOOK_STATE_FILE, "utf8"));
      }
    } catch {
      /* corrupt or missing — fall back to writing just our own fields */
    }
    fs.writeFileSync(
      MOLTBOOK_STATE_FILE,
      JSON.stringify({
        ...existing,
        lastPostAt: state.lastPostAt,
        publishedTitleHashes: [...state.titleHashes],
      }),
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
    // Real per-request free-tier quota counter (Groq/Gemini), shared by
    // every task this agent instance processes — see llmPricing.js for
    // why this exists and where its numbers come from.
    this.llmQuota = new DailyQuotaTracker({ persistDir });
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

    // FIX: was `this.connectors.get("supabase")`, which throws for any
    // agent that doesn't register a "supabase" connector — every unit
    // test that builds a minimal agent, and both approvalCli.js and
    // maintenanceCli.js in production (they construct `new
    // UniversalAgent()` directly, not via buildAgent()). This is an
    // optional memory feature; a missing connector must degrade to "off",
    // not crash the entire task. See connectorRegistry.js getOptional().
    const supabase = this.connectors.getOptional("supabase");
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
      this.economics.record({ type: "task_failed", taskId, model: generation.model, connector: task.sourceConnector });
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

    // FIX: was hardcoded `costUsd: 0` for every completed task regardless
    // of which provider actually served it — meaning economicIntelligence's
    // totalCostUsd/totalProfitUsd/bestPlatform()/bestModel() were always
    // computing 100% margin, even on calls that hit Grok (this project's
    // one genuinely paid, non-free-tier provider). Real cost now: $0 if
    // this request landed inside today's real Groq/Gemini free quota
    // (and that quota unit is consumed here, so the next call correctly
    // sees less headroom left today), the real priced $ amount otherwise
    // — see llmPricing.js for the sourced per-token rates and the daily
    // quota tracker.
    this.economics.record({
      type: "task_completed",
      taskId,
      model: generation.model,
      connector: task.sourceConnector,
      revenueUsd: task.rewardUsd || 0,
      costUsd: estimateCostUsd(generation.provider, generation.model, generation.usage, this.llmQuota),
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

    // FIX: same unguarded-get() crash risk as the Supabase hook above —
    // an agent that doesn't register "moltbook" (any minimal/test agent,
    // approvalCli.js, maintenanceCli.js) must not have this optional,
    // fire-and-forgotten side effect crash the caller.
    const moltbook = this.connectors.getOptional("moltbook");
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
      // FIX (unified security gate): this used to call moltbook.createPost()
      // directly — bypassing killSwitch.assertCanAct(), the connectors.
      // supports() check, and rateLimiter.assertConsume() entirely. A
      // kill-switch trip or a connector-level rate limit on "moltbook"
      // had NO effect on this specific code path, even though every
      // other external call in this project (including colony's own
      // auto-post in marketplacePipeline.js) goes through callConnector().
      // Routed through it now, consistent with that existing pattern —
      // same "PUBLISH" (MEDIUM risk) action colony already uses.
      // FIX: moltbook.createPost() now expects `content`, not `body` (the
      // real Moltbook API's actual field name — see the fix note in
      // connectors/moltbook.js). `body` here is just this function's own
      // local variable holding the markdown text; only the KEY passed to
      // createPost() needed to change, not the local name.
      const response = await this.callConnector("moltbook", "createPost", "PUBLISH", () =>
        moltbook.createPost({ title, content: body, submolt: "general" })
      );

      const challenge = moltbook.extractChallenge(response);
      if (challenge) {
        try {
          const answer = moltbook.solveChallenge(challenge.challenge);
          await this.callConnector("moltbook", "createPost", "PUBLISH", () => moltbook.verifyChallenge(challenge.code, answer));
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
      // FIX (real production evidence, 2026-09-30): lastPostAt was ONLY
      // being updated on success. Once Moltbook's server-side rate limit
      // was already tripped, every task-completion for the rest of that
      // window immediately re-attempted and re-failed with the same 429,
      // with zero backoff — logs showed exactly this
      // (MOLTBOOK_POST_FAILED, 429, "remaining":0). The server's own
      // retry_after_seconds in that case was only 42s — far shorter than
      // our normal cooldown — so simply engaging the existing cooldown on
      // ANY failure (not just success) is already more than sufficient;
      // no need to parse the exact retry-after value.
      this._moltbookPostState.lastPostAt = Date.now();
      saveMoltbookPostState(this._moltbookPostState);
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

    // FIX (approval replay / race condition — exactly what was asked to be
    // prevented): this used to just check `record.status === "approved"`
    // and proceed straight to processTask(). Two near-simultaneous calls
    // to resumeTask() for the SAME approvalId — a double-tap on a
    // Telegram button, a retried webhook, a human running
    // `approvalCli.js resume` while the Telegram bot is also handling it
    // — would BOTH pass that check and BOTH execute the task (and, before
    // the economicIntelligence idempotency fix, both record revenue for
    // it too). `claim()` is an atomic compare-and-swap: only the first
    // caller succeeds; every other concurrent caller gets a ConflictError
    // here and returns a clear "already being handled" result instead of
    // re-running anything.
    const { ConflictError } = require("./approvalQueue");
    let claimed;
    try {
      claimed = this.approvals.claim(approvalId, this.agentId);
    } catch (err) {
      if (err instanceof ConflictError) {
        // Two genuinely different situations produce the same ConflictError
        // from claim(), and callers deserve different answers for each:
        //   - record.status is "denied" or "pending": this was never a
        //     race, there's just nothing approved to run — preserve the
        //     original, more specific status so callers checking for
        //     exactly "denied"/"pending" keep working.
        //   - record.status is "claimed"/"executing"/"consumed"/"failed":
        //     this IS the real race/replay case — someone else (possibly
        //     this very approvalId being resumed twice concurrently) got
        //     there first. "conflict" is the honest answer here.
        const fresh = this.approvals.get(approvalId);
        if (fresh && (fresh.status === "denied" || fresh.status === "pending")) {
          return { status: fresh.status, approvalId, message: `Approval "${approvalId}" is "${fresh.status}", not "approved" — nothing to resume.` };
        }
        return { status: "conflict", approvalId, message: err.message };
      }
      throw err;
    }

    if (!claimed.resumable || !claimed.task) {
      // Nothing to actually execute — but it's claimed now, so mark it
      // failed rather than leaving it stuck in "claimed" forever.
      this.approvals.fail(approvalId, claimed.version, "not resumable: no stored task");
      return { status: "not_resumable", approvalId, message: "This approval has no stored task to resume automatically." };
    }

    const executing = this.approvals.markExecuting(approvalId, claimed.version);
    this._approvedOverrides.add(record.taskId);
    try {
      const result = await this.processTask(claimed.task);
      this.approvals.consume(approvalId, executing.version, { taskStatus: result.status });
      return result;
    } catch (err) {
      try {
        this.approvals.fail(approvalId, executing.version, err.message);
      } catch {
        /* best-effort — the original error below is what matters */
      }
      throw err;
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
      // Real remaining free-tier headroom for today (UTC), so an operator
      // can see "we're about to fall through to paid Grok" before it
      // happens, not just after the bill shows it. Infinity means this
      // provider has no tracked free quota (e.g. it's never been called
      // yet, or it's not one of the two free-tier providers).
      llmQuotaRemainingToday: {
        groq: this.llmQuota.remainingToday("GroqClient"),
        gemini: this.llmQuota.remainingToday("GeminiClient"),
      },
      learning: this.learning.status(),
      connectors: this.connectors.list(),
      pendingApprovals: this.approvals.list({ status: "pending" }).length,
      auditEntryCount: this.audit.all().length,
    };
  }
}

module.exports = UniversalAgent;
