"use strict";

/**
 * Deterministic token/compute budgeting. No LLM calls are made here — this
 * is pure arithmetic, per section 4 of the architecture spec ("use normal
 * code for ... cost calculations").
 *
 * Token estimate uses the common ~4-chars-per-token heuristic. It is an
 * estimate, not a real tokenizer count — documented as such rather than
 * presented as exact.
 */

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

const MAX_TRACKED_TASKS = 5000;

const DEFAULT_LIMITS = {
  maxTokensPerTask: Number(process.env.MAX_TOKENS_PER_TASK || 8000),
  maxTokensPerOperation: Number(process.env.MAX_TOKENS_PER_OPERATION || 4000),
  maxLlmCallsPerTask: Number(process.env.MAX_LLM_CALLS_PER_TASK || 4),
  maxDailyTokens: Number(process.env.MAX_DAILY_TOKENS || 500000),
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 2000),
};

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

class TokenController {
  /**
   * With `persistDir`, today's usage survives a restart. Before, every redeploy/crash-restart reset
   * dailyUsed to 0, so MAX_DAILY_TOKENS was not a real daily cap on a service that restarts.
   */
  constructor(limits = {}, { persistDir, encryptionKey } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.dailyUsed = 0;
    this.dailyResetAt = startOfNextDay();
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "token-usage.json"), { encryptionKey }) : null;
    if (this._store) {
      try {
        const saved = this._store.load(null);
        if (saved && Number.isFinite(saved.dailyResetAt) && Date.now() < saved.dailyResetAt && Number.isFinite(saved.dailyUsed)) {
          this.dailyUsed = saved.dailyUsed;
          this.dailyResetAt = saved.dailyResetAt;
        }
      } catch (err) {
        console.warn(`[tokenController] could not restore daily usage: ${err.message}`);
      }
    }
    this.perTaskUsage = new Map(); // taskId -> { tokens, llmCalls }
  }

  _rolloverDayIfNeeded() {
    if (Date.now() >= this.dailyResetAt) {
      this.dailyUsed = 0;
      this.dailyResetAt = startOfNextDay();
    }
  }

  /**
   * Called BEFORE an LLM call is made. Throws a structured decision object
   * (not an exception) so the caller can decide to simplify/cache/refuse
   * rather than always throwing.
   */
  preflight(taskId, { systemPrompt, userPrompt }) {
    this._rolloverDayIfNeeded();

    const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
    const estimatedOutputTokens = Math.min(this.limits.maxOutputTokens, 1000);
    const estimatedTotal = estimatedInputTokens + estimatedOutputTokens;

    const usage = this.perTaskUsage.get(taskId) || { tokens: 0, llmCalls: 0 };

    const reasons = [];
    if (usage.llmCalls + 1 > this.limits.maxLlmCallsPerTask) {
      reasons.push(
        `Task ${taskId} would exceed maxLlmCallsPerTask (${this.limits.maxLlmCallsPerTask}).`
      );
    }
    if (usage.tokens + estimatedTotal > this.limits.maxTokensPerTask) {
      reasons.push(
        `Task ${taskId} would exceed maxTokensPerTask (${this.limits.maxTokensPerTask}).`
      );
    }
    if (estimatedTotal > this.limits.maxTokensPerOperation) {
      reasons.push(
        `Single operation estimate (${estimatedTotal}) exceeds maxTokensPerOperation (${this.limits.maxTokensPerOperation}).`
      );
    }
    if (this.dailyUsed + estimatedTotal > this.limits.maxDailyTokens) {
      reasons.push(`Daily token budget (${this.limits.maxDailyTokens}) would be exceeded.`);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTotal,
    };
  }

  /**
   * Called AFTER a real LLM call completes, with the actual usage the
   * provider reported (or an estimate if the provider didn't report one).
   */
  record(taskId, actualTokens) {
    this._rolloverDayIfNeeded();
    this.dailyUsed += actualTokens;

    const usage = this.perTaskUsage.get(taskId) || { tokens: 0, llmCalls: 0 };
    usage.tokens += actualTokens;
    usage.llmCalls += 1;
    this.perTaskUsage.delete(taskId);
    this.perTaskUsage.set(taskId, usage); // re-insert = most recently used
    while (this.perTaskUsage.size > MAX_TRACKED_TASKS) this.perTaskUsage.delete(this.perTaskUsage.keys().next().value); // bounded memory
    if (this._store) {
      try {
        this._store.save({ dailyUsed: this.dailyUsed, dailyResetAt: this.dailyResetAt });
      } catch {
        /* best effort */
      }
    }
    return usage;
  }

  getUsage(taskId) {
    return this.perTaskUsage.get(taskId) || { tokens: 0, llmCalls: 0 };
  }

  getDailyUsage() {
    this._rolloverDayIfNeeded();
    return { used: this.dailyUsed, limit: this.limits.maxDailyTokens };
  }
}

function startOfNextDay() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

module.exports = { TokenController, estimateTokens };
