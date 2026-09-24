"use strict";

/**
 * OpenTask.ai strategy for MarketplacePipeline. Same bid-first economic
 * logic as Molt Market: draft and submit a bid/proposal on an open task
 * rather than producing the full deliverable before any commitment exists.
 *
 * HONESTY NOTE: built from OpenTask's documented high-level API surface
 * (see connectors/openTask.js) using a conventional REST field-naming
 * guess (`reward_usd`, `title`, `description`) — not verified field-by-field
 * against a live account. toOpportunity/toTask below check several
 * plausible field-name spellings defensively rather than trust one guess,
 * the same lesson learned the hard way on AgentMarket ("budget") and
 * Molt Market ("budget_usdc" vs "budgetUsdc"). A live 401 on the actual
 * bid submission (despite discovery working with the same token) has also
 * been observed — the fix was route confusion: the write path is
 * /agent/tasks/{id}/bids (bearer route), NOT /tasks/{id}/bids (browser
 * route). See connectors/openTask.js for the corrected submitBid.
 *
 * QA FIX #1: the deliverable is drafted by the `proposal` capability (the
 * goal literally asks for a proposal), but the task type was declared as
 * "communication". The verification layer compares those two and rejects
 * on mismatch. Type is now declared as "proposal" so the criteria matches
 * what actually gets produced.
 *
 * QA FIX #2: even after the type fix, QA kept rejecting because the
 * proposal read as too generic ("I can help", no concrete file names,
 * no tools, no timeline). The goal is now a structured brief that
 * forbids filler and mandates: named deliverable files, concrete tools,
 * an ETA in days, and one clarifying question.
 *
 * QA FIX #3: bid submission started failing with 400 "expected string,
 * received undefined" on `expectedTaskUpdatedAt` — OpenTask's write route
 * requires this as an optimistic-concurrency check (the bidder must echo
 * back the task's last-known update timestamp). The exact source field
 * name on the raw task object is unconfirmed (no docs available), so a
 * temporary debug log is included below in `discover` to print the raw
 * task shape once. Remove the two console.log lines once the correct
 * field name is confirmed from the logs, and narrow the fallback chain
 * in `submit` accordingly.
 */

const MIN_REWARD_USD = Number(process.env.OPENTASK_MIN_REWARD_USD || 1);
const BID_RATIO = Number(process.env.OPENTASK_BID_RATIO || 1.0); // 1.0 = bid the full listed reward
const DEFAULT_ETA_DAYS = Number(process.env.OPENTASK_DEFAULT_ETA_DAYS || 1);

// Session-lifetime de-dupe — avoids re-bidding the same still-open task
// every time /opentask is run (resets on redeploy; no cross-restart store
// exists yet).
const _attemptedTaskIds = new Set();

// Confirmed via /raw against a live account: OpenTask returns
// `budgetAmount` as a STRING (e.g. "9") plus `budgetCurrency: "USDC"` and
// a human `budgetText` like "9 USDC" — not `reward_usd`, which was a
// pre-verification guess that never matched. USDC is treated as ~1:1 USD
// here, same simplification already used for Molt Market/Molt Jobs.
function extractReward(raw) {
  if (typeof raw.budgetAmount === "string" || typeof raw.budgetAmount === "number") {
    const n = parseFloat(raw.budgetAmount);
    if (Number.isFinite(n)) return n;
  }
  if (typeof raw.budgetText === "string") {
    const m = raw.budgetText.match(/[\d.]+/);
    if (m) return parseFloat(m[0]);
  }
  // Older guesses, kept in case a different task shape ever shows up.
  const candidates = [raw.reward_usd, raw.rewardUsd, raw.budget_usd, raw.budgetUsd, raw.price_usd, raw.priceUsd, raw.amount_usd, raw.amountUsd];
  const found = candidates.find((v) => typeof v === "number");
  return typeof found === "number" ? found : null;
}

/** Bigger rewards on an open marketplace draw more competing bidders. */
function estimateWinRate(rewardUsd) {
  const base = Number(process.env.OPENTASK_DEFAULT_BID_WIN_RATE || 0.4);
  if (!(typeof rewardUsd === "number") || rewardUsd <= 0) return 0;
  if (rewardUsd >= 100) return Math.max(0.1, base - 0.25);
  if (rewardUsd >= 25) return Math.max(0.2, base - 0.1);
  return base;
}

/**
 * The proposal-writing brief. Structured on purpose: OpenTask's QA layer
 * rejects generic proposals ("I can help", "I am a good fit") as
 * unverifiable. This brief forces concrete, checkable content instead.
 */
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
    "   Example: '1. Parse input with Python csv module. 2. Validate against",
    "   jsonschema. 3. Run pytest suite (12 tests). 4. Package + README.'.",
    "",
    "3. TIMELINE: State the delivery window in days (e.g. 'Delivery in 2 days').",
    "",
    "4. CLARIFYING QUESTION: End with one specific question about the task",
    "   that shows domain expertise.",
    "",
    "FORBIDDEN PHRASES (using any of these will cause automatic rejection):",
    "- 'I am a good fit'",
    "- 'I can help'",
    "- 'I have experience'",
    "- 'I am confident'",
    "- Any sentence that could apply to any task on any platform.",
    "",
    "Tone: confident, specific, technical. Output plain text only. No markdown headers.",
  ].join("\n");
}

const openTaskStrategy = {
  connectorName: "openTask",

  discoverOperation: "discoverTasks",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    const data = await connector.discoverTasks({ status: "open" });
    const tasks = Array.isArray(data) ? data : data.tasks || data.results || [];
    // TEMP DEBUG (QA FIX #3): print the raw task shape once so the correct
    // field name for the bid's `expectedTaskUpdatedAt` can be confirmed.
    // Remove these two lines once confirmed.
    if (tasks.length > 0) {
      console.log("[DEBUG openTask raw task keys]", Object.keys(tasks[0]));
      console.log("[DEBUG openTask raw task sample]", JSON.stringify(tasks[0], null, 2));
    }
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
    // QA FIX #1: type matches the `proposal` capability that actually
    // produces the deliverable (the goal below asks for a proposal).
    type: "proposal",
    input: {
      context: `Open task on OpenTask.ai — Title: "${raw.title}". Description: ${raw.description || raw.skillsTags?.join(", ") || "n/a"}. Budget: ${raw.budgetText || (extractReward(raw) != null ? `${extractReward(raw)} ${raw.budgetCurrency || "USDC"}` : "unspecified")}. Required skills: ${Array.isArray(raw.skillsTags) ? raw.skillsTags.join(", ") : "n/a"}.`,
      // QA FIX #2: structured brief forbidding generic filler.
      goal: buildProposalGoal(),
      raw, // preserved so the post-approval auto-submit step can rebuild the real bid
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
      _attemptedTaskIds.add(raw.id); // permanently unusable listing — don't re-draft for it every cycle
      throw new Error(`Skipping bid on task ${raw.id}: no usable reward found (checked budgetAmount/budgetText/reward_usd, all missing or below the $${MIN_REWARD_USD} floor).`);
    }
    try {
      // The connector now expects the confirmed bearer-route schema:
      // priceText + etaDays + approach + expectedTaskUpdatedAt (see
      // connectors/openTask.js, which posts to /agent/tasks/{id}/bids —
      // the browser route at /tasks/{id}/bids always 401s for an API
      // token).
      //
      // QA FIX #3: expectedTaskUpdatedAt field name is unconfirmed — see
      // the debug log in `discover` above. Narrow this fallback chain to
      // the real field once confirmed.
      const result = await connector.submitBid(raw.id, {
        priceText: `${Math.round(reward * BID_RATIO * 100) / 100} ${raw.budgetCurrency || "USDC"}`,
        etaDays: DEFAULT_ETA_DAYS,
        approach: proposalText,
        expectedTaskUpdatedAt: raw.updatedAt || raw.taskUpdatedAt || raw.updated_at || raw.lastUpdated || "",
      });
      _attemptedTaskIds.add(raw.id);
      return result;
    } catch (err) {
      // Mark it attempted even on failure. A task that consistently fails
      // (e.g. quietly closed/expired server-side despite still listing as
      // "open") would otherwise get re-drafted and re-attempted forever,
      // every single /opentask run, burning LLM calls on something that
      // will never succeed — and worse, silently blocking the pipeline
      // from ever reaching the next-best real opportunity.
      _attemptedTaskIds.add(raw.id);
      throw err;
    }
  },
};

module.exports = openTaskStrategy;
