"use strict";

/**
 * OpenTask.ai strategy for MarketplacePipeline.
 *
 * See connectors/openTask.js for the full list of API-level corrections.
 * At this layer we only need to:
 *   1. Recognize the two distinct 409s OpenTask can return:
 *      - scope_change: reload task, retry once with fresh updatedAt.
 *      - active_offer: withdraw old bid (by bidId) + POST a new one.
 *   2. Mark a task as "attempted" (session-lifetime Set) so we don't
 *      re-draft a proposal for it every cycle forever.
 *
 * OpenTask has no "edit bid" endpoint — to change terms you withdraw the
 * old bid (PATCH /agent/bids/:bidId {action:"withdraw"}) and POST a fresh
 * one. That is what replaceActiveBid() does below.
 */

const MIN_REWARD_USD = Number(process.env.OPENTASK_MIN_REWARD_USD || 1);
const BID_RATIO = Number(process.env.OPENTASK_BID_RATIO || 1.0);
const DEFAULT_ETA_DAYS = Number(process.env.OPENTASK_DEFAULT_ETA_DAYS || 1);

// Session-lifetime de-dupe (resets on redeploy).
const _attemptedTaskIds = new Set();

// 409-loop guard (production evidence: the same task failed with a 409 every
// 30-minute cycle, forever, doing withdraw + resubmit each time).
//   _permanentFailedIds: taskId -> timestamp (ms) it was blocked at.
//   _submitAttempts:     taskId -> consecutive failed submit() count.
// A task is blocked after MAX_SUBMIT_ATTEMPTS failures and released again
// after PERMANENT_BLOCK_MS. Both maps are in-memory (reset on redeploy).
const _permanentFailedIds = new Map();
const _submitAttempts = new Map();
// A typo'd env value (NaN) would silently disable the guard (attempts >= NaN
// is never true), so invalid or non-positive values fall back to the default.
const positiveNumber = (raw, fallback) => (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback);
const PERMANENT_BLOCK_MS = positiveNumber(process.env.OPENTASK_PERMANENT_BLOCK_MS, 24 * 60 * 60 * 1000);
const MAX_SUBMIT_ATTEMPTS = positiveNumber(process.env.OPENTASK_MAX_SUBMIT_ATTEMPTS, 3);
// taskId -> time of the last failed submit. Failures older than
// PERMANENT_BLOCK_MS stop counting, so "consecutive" really means recent and
// the counter map can't grow forever with one-off failures.
const _lastFailureAt = new Map();
// OpenTask needs a moment between withdrawing a bid and accepting a new one
// for the same task; resubmitting instantly can 409 again. Read at call time.
const replaceDelayMs = () => {
  const n = Number(process.env.OPENTASK_REPLACE_DELAY_MS ?? 2500);
  return Number.isFinite(n) && n >= 0 ? n : 2500;
};

/** True while the task is blocked. An expired block is lifted (and its attempt counter reset). */
function isPermanentlyBlocked(taskId) {
  const blockedAt = _permanentFailedIds.get(taskId);
  if (blockedAt === undefined) return false;
  if (Date.now() - blockedAt >= PERMANENT_BLOCK_MS) {
    _permanentFailedIds.delete(taskId);
    _submitAttempts.delete(taskId);
    _lastFailureAt.delete(taskId);
    return false;
  }
  return true;
}

/** Drops attempt counters whose last failure is older than the block window. */
function pruneStaleAttempts() {
  const now = Date.now();
  for (const [id, at] of [..._lastFailureAt]) {
    if (now - at >= PERMANENT_BLOCK_MS && !_permanentFailedIds.has(id)) {
      _lastFailureAt.delete(id);
      _submitAttempts.delete(id);
    }
  }
}

function recordSubmitFailure(taskId) {
  pruneStaleAttempts();
  const attempts = (_submitAttempts.get(taskId) || 0) + 1;
  _submitAttempts.set(taskId, attempts);
  _lastFailureAt.set(taskId, Date.now());
  if (attempts >= MAX_SUBMIT_ATTEMPTS) {
    _permanentFailedIds.set(taskId, Date.now());
    console.log(`[openTask] task ${taskId} blocked permanently after ${attempts} attempts`);
  }
}

function extractReward(raw) {
  if (typeof raw.budgetAmount === "string" || typeof raw.budgetAmount === "number") {
    const n = parseFloat(raw.budgetAmount);
    if (Number.isFinite(n)) return n;
  }
  if (typeof raw.budgetText === "string") {
    const m = raw.budgetText.match(/[\d.]+/);
    if (m) return parseFloat(m[0]);
  }
  const candidates = [
    raw.reward_usd, raw.rewardUsd, raw.budget_usd, raw.budgetUsd,
    raw.price_usd, raw.priceUsd, raw.amount_usd, raw.amountUsd,
  ];
  const found = candidates.find((v) => typeof v === "number");
  return typeof found === "number" ? found : null;
}

function estimateWinRate(rewardUsd) {
  const base = Number(process.env.OPENTASK_DEFAULT_BID_WIN_RATE || 0.4);
  if (!(typeof rewardUsd === "number") || rewardUsd <= 0) return 0;
  if (rewardUsd >= 100) return Math.max(0.1, base - 0.25);
  if (rewardUsd >= 25) return Math.max(0.2, base - 0.1);
  return base;
}

function buildProposalGoal() {
  return [
    "Draft a concise, professional proposal for this task.",
    "",
    "MANDATORY STRUCTURE — the proposal MUST contain all four sections:",
    "",
    "1. DELIVERABLE: Name the exact file(s) you will produce.",
    "   Example: 'openapi.yaml (OpenAPI 3.0 spec)', 'csv_to_json.py (Python 3.11 script)'.",
    "   DO NOT write vague nouns like 'the document' or 'the solution'.",
    "",
    "2. EXECUTION STEPS: List 3-5 numbered, concrete steps.",
    "   Each step must name a specific tool, library, or standard.",
    "",
    "3. TIMELINE: State the delivery window in days (e.g. 'Delivery in 2 days').",
    "",
    "4. CLARIFYING QUESTION: End with one specific question about the task.",
    "",
    "FORBIDDEN PHRASES (using any of these will cause automatic rejection):",
    "- 'I am a good fit'",
    "- 'I can help'",
    "- 'I have experience'",
    "- 'I am confident'",
    "",
    "Tone: confident, specific, technical. Output plain text only.",
  ].join("\n");
}

/**
 * Distinguishes the two 409s we care about.
 */
function classify409(err) {
  const msg = String((err && (err.body || err.message)) || "").toLowerCase();
  if (msg.includes("bid_task_scope_changed") || msg.includes("scope changed") || msg.includes("reloadrequired")) {
    return "scope_change";
  }
  if (msg.includes("active offer") || msg.includes("active bid") || msg.includes("update it instead") || msg.includes("already have")) {
    return "active_offer";
  }
  return "permanent";
}

/**
 * Replace the agent's existing active bid on a task: withdraw the old one
 * by bidId, then POST a fresh one. This is the documented two-step way to
 * change bid terms (OpenTask has no "edit bid" endpoint).
 */
async function replaceActiveBid(connector, taskId, newPayload) {
  const bids = await connector.getMyActiveBids();
  const existing = bids.find((b) => (b.taskId || b.task_id) === taskId);
  if (!existing || !existing.id) {
    // No active bid actually found — try a plain new POST as a fallback.
    return connector.submitBid(taskId, newPayload);
  }
  await connector.withdrawBid(existing.id);
  await new Promise((r) => setTimeout(r, replaceDelayMs()));
  try {
    return await connector.submitBid(taskId, newPayload);
  } catch (err) {
    // The old bid is already withdrawn. Left as-is, a persistent 409 here
    // meant every cycle destroyed our live bid and replaced it with nothing.
    // Best effort: put the previous terms back before reporting the failure.
    const prev = {
      priceText: existing.priceText || existing.price_text,
      etaDays: existing.etaDays || existing.eta_days,
      approach: existing.approach,
      expectedTaskUpdatedAt: newPayload.expectedTaskUpdatedAt,
    };
    if (prev.priceText && prev.approach) {
      try {
        await connector.submitBid(taskId, prev);
        console.warn(`[openTask] resubmit failed on ${taskId}; previous bid restored.`);
      } catch (restoreErr) {
        console.warn(`[openTask] resubmit failed on ${taskId} and the previous bid could NOT be restored: ${restoreErr.message}`);
      }
    } else {
      console.warn(`[openTask] resubmit failed on ${taskId}; previous bid terms unknown, so it was not restored.`);
    }
    throw err;
  }
}

const openTaskStrategy = {
  connectorName: "openTask",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const data = await connector.discoverTasks({ status: "open" });
    const tasks = Array.isArray(data) ? data : data.tasks || data.results || [];
    // Lift every expired block first (not only for tasks still listed).
    for (const id of [..._permanentFailedIds.keys()]) isPermanentlyBlocked(id);
    pruneStaleAttempts();
    return tasks.filter((task) => {
      if (!task || !task.id || _attemptedTaskIds.has(task.id)) return false;
      if (isPermanentlyBlocked(task.id)) {
        console.log(`[openTask] task ${task.id} skipped: permanently blocked`);
        return false;
      }
      return true;
    });
  },

  toOpportunity: (raw) => {
    const reward = extractReward(raw);
    const usable = typeof reward === "number" && reward >= MIN_REWARD_USD;
    return {
      id: raw.id,
      type: "opentask_task",
      rewardUsd: usable ? reward : 0,
      successProbability: usable ? estimateWinRate(reward) : 0,
      estimatedModelCostUsd: 0,
      platformFeeUsd: Number(process.env.OPENTASK_ESTIMATED_FEE_USD || 0),
      riskLevel: "MEDIUM",
    };
  },

  toTask: (raw) => ({
    id: `opentask-bid-${raw.id}`,
    type: "proposal",
    input: {
      context: `Open task on OpenTask.ai — Title: "${raw.title}". Description: ${raw.description || raw.skillsTags?.join(", ") || "n/a"}. Budget: ${raw.budgetText || (extractReward(raw) != null ? `${extractReward(raw)} ${raw.budgetCurrency || "USDC"}` : "unspecified")}. Required skills: ${Array.isArray(raw.skillsTags) ? raw.skillsTags.join(", ") : "n/a"}.`,
      goal: buildProposalGoal(),
      raw,
    },
    untrustedContent: raw.description || raw.title,
    untrustedSource: "opentask-listing",
    sourceConnector: "openTask",
  }),

  submitOperation: "submitBid",
  submitPermission: "SUBMIT_TASK",
  // FIX (same class of bug found and fixed earlier in strategies/agentMarket.js,
  // now found here too on a second look): every failure branch below used to
  // call `_attemptedTaskIds.add(raw.id)` before rethrowing — including plain
  // transient failures (a network blip on submitBid, on the reload-after-
  // scope-change call, or on the withdraw+resubmit call). That permanently
  // excludes a task from this process's discovery for the rest of its
  // lifetime, even when the task is still open and perfectly biddable —
  // silently overriding learningEngine's own, more nuanced retryable-vs-
  // permanent classification (in marketplacePipeline.js) with a blunt,
  // un-logged, permanent skip. Now `_attemptedTaskIds` is only ever added
  // to on a genuine SUCCESS (the task now has our bid on it, correctly
  // skip it going forward) or the one truly permanent, non-network
  // condition (no usable reward — that won't change by retrying). Every
  // error path below rethrows WITHOUT blacklisting, so the task is simply
  // reconsidered next cycle.
  submit: async (connector, raw, proposalText) => {
    // Blocked tasks fail fast, with no network request at all.
    if (isPermanentlyBlocked(raw.id)) {
      console.log(`[openTask] task ${raw.id} skipped: permanently blocked`);
      throw new Error(`Task ${raw.id} skipped: permanently blocked after ${MAX_SUBMIT_ATTEMPTS} failed attempts`);
    }
    try {
      const result = await submitOnce(connector, raw, proposalText);
      _submitAttempts.delete(raw.id); // success resets the counter
      _lastFailureAt.delete(raw.id);
      return result;
    } catch (err) {
      // "No usable reward" is already permanent via _attemptedTaskIds; don't double-count.
      if (!_attemptedTaskIds.has(raw.id)) recordSubmitFailure(raw.id);
      throw err;
    }
  },
};

// Original submit logic, unchanged apart from being a standalone function.
async function submitOnce(connector, raw, proposalText) {
  const reward = extractReward(raw);
  if (!(typeof reward === "number" && reward >= MIN_REWARD_USD)) {
    _attemptedTaskIds.add(raw.id); // permanent: no reward will appear on retry
    throw new Error(
      `Skipping bid on task ${raw.id}: no usable reward found (checked budgetAmount/budgetText/reward_usd, all missing or below the $${MIN_REWARD_USD} floor).`
    );
  }

  const buildPayload = (snapshot) => ({
    priceText: `${Math.round(reward * BID_RATIO * 100) / 100} ${snapshot.budgetCurrency || "USDC"}`,
    etaDays: DEFAULT_ETA_DAYS,
    approach: proposalText,
    expectedTaskUpdatedAt: snapshot.updatedAt || snapshot.createdAt || new Date().toISOString(),
  });

  try {
    const result = await connector.submitBid(raw.id, buildPayload(raw));
    _attemptedTaskIds.add(raw.id); // success: we now have a bid in
    return result;
  } catch (err) {
    const kind = classify409(err);

    // ---- Case 1: an active bid already exists → withdraw + resubmit ----
    if (kind === "active_offer") {
      console.warn(`[openTask] active bid conflict on ${raw.id} — withdrawing old bid and resubmitting.`);
      try {
        const result = await replaceActiveBid(connector, raw.id, buildPayload(raw));
        _attemptedTaskIds.add(raw.id); // success
        return result;
      } catch (replaceErr) {
        throw new Error(`Task ${raw.id}: could not replace active bid: ${replaceErr.message}`);
      }
    }

    // ---- Case 2: the task itself changed → reload once, retry once ----
    if (kind === "scope_change") {
      console.warn(`[openTask] 409 scope change on ${raw.id} — reloading task and retrying once with fresh updatedAt.`);

      let fresh;
      try {
        fresh = await connector.getTask(raw.id);
      } catch (reloadErr) {
        throw new Error(`Task ${raw.id} scope changed; reload failed: ${reloadErr.message}`);
      }

      // Always target the task we were asked about: a reload body without an
      // id used to produce POST /tasks/undefined/bids.
      const freshTask = { ...(fresh?.task || fresh?.data || fresh), id: raw.id };

      try {
        const result = await connector.submitBid(freshTask.id, buildPayload(freshTask));
        _attemptedTaskIds.add(raw.id); // success
        return result;
      } catch (retryErr) {
        // If the retry failed because we now have an active bid (the task
        // changed between discovery and reload in a way that revealed an
        // existing offer), do the withdraw+resubmit dance once.
        if (classify409(retryErr) === "active_offer") {
          try {
            const result = await replaceActiveBid(connector, freshTask.id, buildPayload(freshTask));
            _attemptedTaskIds.add(raw.id); // success
            return result;
          } catch (replaceErr2) {
            throw new Error(`Task ${raw.id}: scope changed, then active-bid replace failed: ${replaceErr2.message}`);
          }
        }
        throw new Error(`Task ${raw.id} scope changed twice (retry also failed): ${retryErr.message}`);
      }
    }

    // ---- Any other error (network blip, 5xx, timeout): NOT permanent.
    // Rethrown as-is and left to marketplacePipeline.js's learningEngine
    // circuit breaker, which classifies retryable vs. non-retryable
    // failures properly — this strategy no longer overrides that with a
    // blunt, permanent, un-logged skip.
    throw err;
  }
}

Object.assign(openTaskStrategy, { _permanentFailedIds, _submitAttempts, _attemptedTaskIds, _lastFailureAt });

module.exports = openTaskStrategy;
