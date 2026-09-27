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
  return connector.submitBid(taskId, newPayload);
}

const openTaskStrategy = {
  connectorName: "openTask",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const data = await connector.discoverTasks({ status: "open" });
    const tasks = Array.isArray(data) ? data : data.tasks || data.results || [];
    return tasks.filter((task) => task && task.id && !_attemptedTaskIds.has(task.id));
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
  submit: async (connector, raw, proposalText) => {
    const reward = extractReward(raw);
    if (!(typeof reward === "number" && reward >= MIN_REWARD_USD)) {
      _attemptedTaskIds.add(raw.id);
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
      _attemptedTaskIds.add(raw.id);
      return result;
    } catch (err) {
      const kind = classify409(err);

      // ---- Case 1: an active bid already exists → withdraw + resubmit ----
      if (kind === "active_offer") {
        console.warn(`[openTask] active bid conflict on ${raw.id} — withdrawing old bid and resubmitting.`);
        try {
          const result = await replaceActiveBid(connector, raw.id, buildPayload(raw));
          _attemptedTaskIds.add(raw.id);
          return result;
        } catch (replaceErr) {
          _attemptedTaskIds.add(raw.id);
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
          _attemptedTaskIds.add(raw.id);
          throw new Error(`Task ${raw.id} scope changed; reload failed: ${reloadErr.message}`);
        }

        const freshTask = fresh?.task || fresh?.data || fresh;

        try {
          const result = await connector.submitBid(freshTask.id, buildPayload(freshTask));
          _attemptedTaskIds.add(raw.id);
          return result;
        } catch (retryErr) {
          // If the retry failed because we now have an active bid (the task
          // changed between discovery and reload in a way that revealed an
          // existing offer), do the withdraw+resubmit dance once.
          if (classify409(retryErr) === "active_offer") {
            try {
              const result = await replaceActiveBid(connector, freshTask.id, buildPayload(freshTask));
              _attemptedTaskIds.add(raw.id);
              return result;
            } catch (replaceErr2) {
              _attemptedTaskIds.add(raw.id);
              throw new Error(`Task ${raw.id}: scope changed, then active-bid replace failed: ${replaceErr2.message}`);
            }
          }
          _attemptedTaskIds.add(raw.id);
          throw new Error(`Task ${raw.id} scope changed twice (retry also failed): ${retryErr.message}`);
        }
      }

      // ---- Any other error: permanent for this task ----
      _attemptedTaskIds.add(raw.id);
      throw err;
    }
  },
};

module.exports = openTaskStrategy;
