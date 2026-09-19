"use strict";

/**
 * Telegram approval bot — a second, mobile-friendly interface onto the
 * exact same `ApprovalQueue`/`UniversalAgent` the CLI (`approvalCli.js`)
 * uses. It does not replace the CLI: it's a thinner layer on top of the
 * same persisted state, useful when a human reviewer is on their phone
 * instead of at a terminal.
 *
 * Scope of this version (deliberately limited): notify on new pending
 * approvals with inline Approve/Deny buttons, and a `/status` command for
 * a dashboard summary. No kill-switch control from Telegram yet — that's
 * a bigger trust decision (who can emergency-stop the agent from their
 * phone) left for a later pass.
 *
 * SECURITY — fails closed like the rest of this platform:
 *   - Requires an explicit chat-id allowlist (TELEGRAM_ALLOWED_CHAT_IDS).
 *     Anyone who is not on it gets "Not authorized." for every command and
 *     every button press — refuses to even start without one, the same
 *     principle as the autonomy-level and kill-switch fail-closed fixes.
 *   - Task input previews are passed through the same `redact()` used by
 *     the audit log before being sent to Telegram's servers, so a
 *     credential accidentally embedded in task content isn't leaked to a
 *     third party. Full task content is NOT sent — only a capped preview.
 *
 * TRANSPORT: long-polling (getUpdates), not a webhook — no public
 * HTTPS endpoint/domain required, matching the "run this anywhere,
 * zero infra" spirit of the rest of the project. Uses the built-in
 * global `fetch` (Node >=18), no external dependency, same convention
 * already used by src/connectors/*.js.
 *
 * Usage:
 *   export TELEGRAM_BOT_TOKEN="123456:ABC..."        # from @BotFather
 *   export TELEGRAM_ALLOWED_CHAT_IDS="111111,222222" # message the bot once,
 *                                                     # then check
 *                                                     # https://api.telegram.org/bot<token>/getUpdates
 *                                                     # to find your chat id
 *   export PERSIST_DIR=./data                        # same dir the agent uses
 *   node src/telegramApprovalBot.js
 */

const path = require("node:path");
const ApprovalQueue = require("./core/approvalQueue");
const UniversalAgent = require("./core/universalAgent");
const { redact } = require("./core/auditLog");
const { JsonFileStore } = require("./core/persistence/fileStore");
// buildAgent() is the SAME agent construction used by the CLI (index.js) —
// it registers all real connectors (Colony, GitHub, OpenTask, MoltMarket,
// MCP, A2A). Using it here (instead of a bare `new UniversalAgent()`) is
// what lets this always-on bot actually see connector status and perform
// real connector calls, not just manage the approval queue.
const { buildAgent, MarketplacePipeline } = require("./index");
const openTaskStrategy = require("./core/strategies/openTask");
const moltMarketStrategy = require("./core/strategies/moltMarket");
const moltJobsStrategy = require("./core/strategies/moltJobs");
const agentMarketStrategy = require("./core/strategies/agentMarket");

const PIPELINE_STRATEGIES = {
  opentask: openTaskStrategy,
  moltmarket: moltMarketStrategy,
  moltjobs: moltJobsStrategy,
  agentmarket: agentMarketStrategy,
};
const PIPELINE_STRATEGIES_BY_CONNECTOR = {
  openTask: openTaskStrategy,
  moltMarket: moltMarketStrategy,
  moltJobs: moltJobsStrategy,
  agentMarket: agentMarketStrategy,
};

const TELEGRAM_API = "https://api.telegram.org";
const MAX_PREVIEW_CHARS = 500;

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const APPROVE_DENY_KEYBOARD = (id) => ({
  inline_keyboard: [
    [
      { text: "✅ Approve", callback_data: `approve:${id}` },
      { text: "❌ Deny", callback_data: `deny:${id}` },
    ],
  ],
});

class TelegramApprovalBot {
  constructor({
    botToken = process.env.TELEGRAM_BOT_TOKEN,
    allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS,
    persistDir = process.env.PERSIST_DIR,
    encryptionKey = process.env.PERSIST_ENCRYPTION_KEY || undefined,
    notifyIntervalMs = Number(process.env.TELEGRAM_NOTIFY_INTERVAL_MS || 15000),
    fetchImpl = typeof fetch !== "undefined" ? fetch : undefined,
  } = {}) {
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is not set. Create a bot via @BotFather and set the token.");
    }
    if (!persistDir) {
      throw new Error(
        "PERSIST_DIR is not set. The bot needs to point at the same persistDir the agent process uses — " +
          "approvals are created by one process and resolved by this bot in another."
      );
    }
    if (!fetchImpl) {
      throw new Error("No fetch implementation available (Node >=18 provides a global fetch).");
    }

    const parsedAllowed = String(allowedChatIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsedAllowed.length === 0) {
      // Fail CLOSED: an approval bot with no allowlist would let anyone who
      // messages it approve high-risk actions. Refuse to start instead.
      throw new Error(
        "TELEGRAM_ALLOWED_CHAT_IDS is not set (or empty) — refusing to start an approval bot with no allowlist. " +
          "Message your bot once, then check https://api.telegram.org/bot<token>/getUpdates to find your chat id."
      );
    }

    this.botToken = botToken;
    this.allowedChatIds = new Set(parsedAllowed);
    this.persistDir = persistDir;
    this.encryptionKey = encryptionKey;
    this.notifyIntervalMs = notifyIntervalMs;
    this._fetch = fetchImpl;
    this._notifiedStore = new JsonFileStore(path.join(persistDir, "telegram-notified.json"), { encryptionKey });
    this._notified = new Set(this._notifiedStore.load([]));
    this._updateOffset = 0;
    this._running = false;
    this._notifyTimer = null;
  }

  // -- Telegram API -------------------------------------------------------

  async _call(method, params = {}) {
    const res = await this._fetch(`${TELEGRAM_API}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram API error on ${method}: ${data.description || res.status}`);
    }
    return data.result;
  }

  _send(chatId, text, extra = {}) {
    return this._call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
  }

  _answerCallback(callbackQueryId, text, showAlert = false) {
    return this._call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
  }

  // -- Fresh, per-call state. Mirrors approvalCli.js's own pattern: a
  // fresh instance per action always reflects the latest persisted state
  // on disk instead of risking a stale in-memory snapshot (this matters
  // because the agent that creates approvals runs as a separate process).
  _freshQueue() {
    return new ApprovalQueue({ persistDir: this.persistDir, encryptionKey: this.encryptionKey });
  }

  _freshAgent() {
    return buildAgent();
  }

  // -- Outbound: notify allowed chats about newly pending approvals -------

  async notifyPendingApprovals() {
    const pending = this._freshQueue().list({ status: "pending" });
    const fresh = pending.filter((r) => !this._notified.has(r.id));

    for (const record of fresh) {
      const text = this._formatApprovalMessage(record);
      for (const chatId of this.allowedChatIds) {
        try {
          await this._send(chatId, text, { reply_markup: APPROVE_DENY_KEYBOARD(record.id) });
        } catch (err) {
          console.error(`Failed to notify chat ${chatId} about ${record.id}:`, err.message);
        }
      }
      this._notified.add(record.id);
    }
    if (fresh.length > 0) this._notifiedStore.save([...this._notified]);
    return fresh.length;
  }

  _formatApprovalMessage(record) {
    const preview = record.task?.input
      ? escapeHtml(JSON.stringify(redact(record.task.input)).slice(0, MAX_PREVIEW_CHARS))
      : "(no input recorded)";
    return (
      `🟡 <b>Approval needed</b> (${record.riskLevel})\n` +
      `id: <code>${record.id}</code>\n` +
      `capability: ${record.capability || "-"}\n` +
      `connector: ${record.connector || "-"}\n` +
      `action: ${record.action}\n` +
      `requested: ${record.requestedAt}\n` +
      `input preview: <code>${preview}</code>`
    );
  }

  // -- Inbound: commands + button presses ----------------------------------

  async handleUpdate(update) {
    if (update.callback_query) return this._handleCallbackQuery(update.callback_query);
    if (update.message) return this._handleMessage(update.message);
  }

  async _handleMessage(msg) {
    const chatId = msg.chat?.id;
    const text = (msg.text || "").trim();

    if (!this.allowedChatIds.has(String(chatId))) {
      await this._send(chatId, "Not authorized.").catch(() => {});
      return;
    }

    if (text === "/start" || text === "/help") {
      await this._send(
        chatId,
        "Universal Digital Agent — approval bot.\n\n" +
          "/status — dashboard summary\n" +
          "/pending — list and re-send buttons for pending approvals\n" +
          "/log — last 10 real connector actions (what the agent actually did)\n" +
          "/colony <text> — make the agent search The Colony right now, live\n" +
          "/opentask — discover open OpenTask.ai tasks and draft a proposal for the best one\n" +
          "/moltmarket — discover open Molt Market jobs and draft a bid for the best one\n" +
          "/moltjobs — discover open MoltJobs.io jobs and draft a bid for the best one\n" +
          "/agentmarket — discover open AgentMarket tasks and draft a bid for the best one\n\n" +
          "Drafted proposals need your approval (/pending) before they're actually sent — " +
          "approving one automatically submits it to the real platform.\n\n" +
          "You'll also get a message automatically whenever a new approval is needed."
      );
      return;
    }

    if (text === "/status" || text === "/dashboard") {
      const dashboard = this._freshAgent().dashboard();
      await this._send(chatId, this._formatDashboard(dashboard));
      return;
    }

    if (text === "/pending" || text === "/list") {
      const pending = this._freshQueue().list({ status: "pending" });
      if (pending.length === 0) {
        await this._send(chatId, "No pending approvals.");
        return;
      }
      for (const record of pending) {
        await this._send(chatId, this._formatApprovalMessage(record), { reply_markup: APPROVE_DENY_KEYBOARD(record.id) });
      }
      return;
    }

    if (text === "/log") {
      const agent = this._freshAgent();
      const entries = agent.audit.all().slice(-10).reverse();
      if (entries.length === 0) {
        await this._send(
          chatId,
          "No audit entries yet — the agent hasn't performed any connector actions. " +
            "Try /colony <search text> to make it do something real."
        );
        return;
      }
      const lines = entries.map((e) => {
        const when = new Date(e.timestamp || Date.now()).toISOString().replace("T", " ").slice(0, 19);
        return `${when} — <b>${escapeHtml(e.connector || e.action || "?")}</b> ${escapeHtml(e.action || "")} → ${escapeHtml(e.result || "?")}${e.error ? ` (${escapeHtml(e.error)})` : ""}`;
      });
      await this._send(chatId, `Last ${entries.length} audit entries:\n\n` + lines.join("\n"));
      return;
    }

    if (text.startsWith("/colony ") || text === "/colony") {
      const query = text.slice("/colony".length).trim();
      if (!query) {
        await this._send(chatId, "Usage: /colony <search text>");
        return;
      }
      const agent = this._freshAgent();
      try {
        const colony = agent.connectors.get("colony");
        const data = await agent.callConnector("colony", "searchPosts", "colony.searchPosts", () =>
          colony.searchPosts(query, { limit: 5 })
        );
        const posts = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
        if (posts.length === 0) {
          await this._send(chatId, `Searched The Colony for "${escapeHtml(query)}" — no results. (Logged to /log.)`);
          return;
        }
        const lines = posts
          .slice(0, 5)
          .map((p, i) => `${i + 1}. ${escapeHtml(p.title || p.body?.slice(0, 80) || "(untitled)")}`);
        await this._send(chatId, `Found ${posts.length} result(s) on The Colony:\n\n` + lines.join("\n") + "\n\n(Logged to /log.)");
      } catch (err) {
        await this._send(chatId, `Colony search failed: ${escapeHtml(err.message)}\n\n(Logged to /log.)`);
      }
      return;
    }

    for (const [cmdName, strategy] of Object.entries(PIPELINE_STRATEGIES)) {
      if (text === `/${cmdName}`) {
        const agent = this._freshAgent();
        const pipeline = new MarketplacePipeline(agent);
        await this._send(chatId, `Searching ${strategy.connectorName} for open opportunities...`);
        try {
          const cycle = await pipeline.runCycle(strategy, { maxOpportunities: 1 });
          if (cycle.status === "pending_human_approval") {
            await this._send(chatId, `Even browsing ${strategy.connectorName} needs approval at the current autonomy level. Check /pending.`);
            return;
          }
          let msg = `<b>${strategy.connectorName}</b>: discovered ${cycle.discovered}, worth pursuing ${cycle.accepted}, skipped (low value) ${cycle.rejected}.`;
          for (const r of cycle.results) {
            if (r.outcome?.status === "pending_human_approval") {
              msg += `\n\nDrafted a proposal for opportunity <code>${escapeHtml(String(r.opportunity.id))}</code> — needs your approval before it's sent. Check /pending.`;
            } else if (r.outcome?.status === "success" && r.submission) {
              msg += `\n\n✅ Submitted a bid on <code>${escapeHtml(String(r.opportunity.id))}</code>.`;
            } else if (r.outcome?.status === "success") {
              msg += `\n\nDrafted but not yet submitted (needs approval). Check /pending.`;
            } else {
              msg += `\n\n⚠️ Opportunity <code>${escapeHtml(String(r.opportunity.id))}</code>: ${escapeHtml(r.outcome?.reason || "failed")}.`;
            }
          }
          if (cycle.results.length === 0) {
            msg += "\n\nNothing met the minimum expected value to pursue right now.";
          }
          await this._send(chatId, msg);
        } catch (err) {
          await this._send(chatId, `${strategy.connectorName} cycle failed: ${escapeHtml(err.message)}`);
        }
        return;
      }
    }

    await this._send(chatId, "Unknown command. Try /help.");
  }

  _formatDashboard(d) {
    const byStatus = d.connectors.reduce((acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    }, {});
    const connectorSummary = Object.entries(byStatus)
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ");
    return (
      `<b>${escapeHtml(d.agentId)}</b>\n` +
      `autonomy level: ${d.autonomyLevel}\n` +
      `kill switch: ${d.killSwitch.globalStopped ? "🔴 STOPPED" : "🟢 running"}` +
      `${d.killSwitch.stoppedConnectors.length ? ` (stopped: ${d.killSwitch.stoppedConnectors.join(", ")})` : ""}\n` +
      `pending approvals: ${d.pendingApprovals}\n` +
      `economics: revenue $${d.economics.totalRevenueUsd.toFixed(2)}, cost $${d.economics.totalCostUsd.toFixed(2)}, profit $${d.economics.totalProfitUsd.toFixed(2)}\n` +
      `connectors: ${connectorSummary}\n` +
      `audit entries: ${d.auditEntryCount}`
    );
  }

  async _handleCallbackQuery(cq) {
    const chatId = cq.message?.chat?.id;
    if (!this.allowedChatIds.has(String(chatId))) {
      await this._answerCallback(cq.id, "Not authorized.", true);
      return;
    }

    const [action, approvalId] = (cq.data || "").split(":");
    if (!["approve", "deny"].includes(action) || !approvalId) {
      await this._answerCallback(cq.id, "Malformed request.", true);
      return;
    }

    const resolvedBy = cq.from?.username ? `telegram:${cq.from.username}` : `telegram:${cq.from?.id ?? "unknown"}`;
    const queue = this._freshQueue();
    const record = queue.get(approvalId);
    if (!record) {
      await this._answerCallback(cq.id, "Approval not found (may already be resolved).", true);
      return;
    }
    if (record.status !== "pending") {
      await this._answerCallback(cq.id, `Already ${record.status}.`, true);
      return;
    }

    if (action === "deny") {
      queue.resolve(approvalId, "denied", resolvedBy);
      await this._answerCallback(cq.id, "Denied.");
      await this._send(chatId, `❌ Denied by ${escapeHtml(resolvedBy)}: <code>${approvalId}</code>`);
      return;
    }

    // approve
    queue.resolve(approvalId, "approved", resolvedBy);
    await this._answerCallback(cq.id, "Approved — executing...");

    if (!record.resumable) {
      await this._send(chatId, `✅ Approved by ${escapeHtml(resolvedBy)}: <code>${approvalId}</code> (no stored task — nothing to auto-run).`);
      return;
    }

    try {
      const agent = this._freshAgent();
      const result = await agent.resumeTask(approvalId);
      const outcome = result.output
        ? `output: <code>${escapeHtml(String(result.output).slice(0, MAX_PREVIEW_CHARS))}</code>`
        : `reason: ${escapeHtml(result.reason || "-")}`;
      await this._send(chatId, `✅ Approved by ${escapeHtml(resolvedBy)} and executed.\nstatus: ${result.status}\n${outcome}`);

      // If this was a marketplace-pipeline draft (has sourceConnector + a
      // stored raw opportunity) and it succeeded, the draft alone is useless
      // sitting in Telegram — actually submit it to the real platform now,
      // via the exact same connector call the pipeline itself would use.
      const sourceConnector = record.task?.sourceConnector;
      const strategy = sourceConnector && PIPELINE_STRATEGIES_BY_CONNECTOR[sourceConnector];
      const raw = record.task?.input?.raw;
      if (strategy && raw && result.status === "success" && result.output) {
        try {
          const connector = agent.connectors.get(strategy.connectorName);
          const submission = await agent.callConnector(
            strategy.connectorName,
            strategy.submitOperation,
            strategy.submitPermission,
            () => strategy.submit(connector, raw, result.output)
          );
          agent.economics.record({
            type: "task_completed",
            connector: strategy.connectorName,
            revenueUsd: raw.reward_usd ?? raw.budget_usdc ?? 0,
            costUsd: 0,
          });
          await this._send(chatId, `📤 Submitted to ${strategy.connectorName} for opportunity <code>${escapeHtml(String(raw.id))}</code>.`);
        } catch (submitErr) {
          agent.economics.record({ type: "task_failed", connector: strategy.connectorName });
          await this._send(chatId, `⚠️ Drafted OK but submitting to ${strategy.connectorName} failed: ${escapeHtml(submitErr.message)}`);
        }
      }
    } catch (err) {
      await this._send(chatId, `⚠️ Approved but execution failed: ${escapeHtml(err.message)}`);
    }
  }

  // -- Long-polling loop ----------------------------------------------------

  async start() {
    this._running = true;
    this._notifyTimer = setInterval(() => {
      this.notifyPendingApprovals().catch((err) => console.error("notifyPendingApprovals failed:", err.message));
    }, this.notifyIntervalMs);
    await this.notifyPendingApprovals();

    while (this._running) {
      let updates;
      try {
        updates = await this._call("getUpdates", { offset: this._updateOffset, timeout: 25 });
      } catch (err) {
        console.error("getUpdates failed:", err.message);
        await sleep(2000);
        continue;
      }
      for (const update of updates) {
        this._updateOffset = update.update_id + 1;
        try {
          await this.handleUpdate(update);
        } catch (err) {
          console.error("Failed to handle update:", err.message);
        }
      }
    }
  }

  stop() {
    this._running = false;
    if (this._notifyTimer) clearInterval(this._notifyTimer);
  }
}

module.exports = TelegramApprovalBot;

if (require.main === module) {
  const bot = new TelegramApprovalBot();
  console.log(`Telegram approval bot starting (allowlist: ${[...bot.allowedChatIds].join(", ")})...`);
  bot.start().catch((err) => {
    console.error("Bot crashed:", err);
    process.exit(1);
  });
  process.on("SIGINT", () => {
    bot.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bot.stop();
    process.exit(0);
  });
}
