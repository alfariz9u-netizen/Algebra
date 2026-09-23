"use strict";

/**
 * Single-process entrypoint that runs everything behind ONE listening HTTP
 * port, so this whole agent can run as a single Render free-tier web
 * service (see docs/setup.md "Running everything on one free service").
 * Render's free tier gives ~750 instance-hours/month per workspace — just
 * enough for ONE always-on service, not several — so combining these three
 * previously-separate entrypoints (`npm run a2a-server`,
 * `npm run telegram-bot`, and the marketplace pipeline demo) into one
 * process is what makes "run everything on the free tier" actually fit.
 *
 * Runs, in this one process, sharing ONE UniversalAgent instance:
 *   1. The inbound A2A server (a2aServer.js) — the only actual listening
 *      port. This is what Render considers "the service", and what an
 *      external uptime pinger (UptimeRobot / cron-job.org, both free)
 *      should hit at GET /healthz every ~10-14 minutes to stop Render's
 *      15-minute idle spin-down from killing everything else here too.
 *   2. The Telegram approval bot (telegramApprovalBot.js), if
 *      TELEGRAM_BOT_TOKEN is set — runs its own long-poll loop
 *      concurrently. Requires PERSIST_DIR (see below). Omit the token to
 *      run without it.
 *   3. The marketplace bidding scheduler — runs one MarketplacePipeline
 *      cycle per configured strategy on a fixed interval
 *      (MARKETPLACE_CYCLE_MS, default 30 minutes — the cadence already
 *      observed in production). Add more strategies to the STRATEGIES
 *      array below as they're built.
 *
 * PERSIST_DIR matters more here than in any single piece run alone: the
 * Telegram bot polls for pending approvals by reading the SAME
 * persistDir this process's agent writes to (they coordinate via disk,
 * not shared memory, even though they're in one process now) — without
 * PERSIST_DIR set, a task that needs human approval will never reach the
 * bot. Render's disk is ephemeral across redeploys either way (see
 * docs/setup.md), which is fine for this — it only needs to survive
 * within one running process, which it does with or without PERSIST_DIR;
 * PERSIST_DIR is what additionally lets the Telegram bot see it.
 *
 * A crash in any ONE of these three is caught and logged rather than
 * taking the whole process down with it — losing the marketplace
 * scheduler to an unhandled error must not also kill the A2A server
 * that's keeping Render awake.
 */

const { buildAgent } = require("./index");
const { createServer } = require("./a2aServer");
const MarketplacePipeline = require("./core/marketplacePipeline");
const moltMarketStrategy = require("./core/strategies/moltMarket");
const agencStrategy = require("./core/strategies/agenc");
const openTaskStrategy = require("./core/strategies/openTask");

// Render sets PORT itself; A2A_SERVER_PORT is honored too for parity with a2aServer.js run standalone.
const PORT = Number(process.env.PORT || process.env.A2A_SERVER_PORT || 8787);
const CYCLE_MS = Number(process.env.MARKETPLACE_CYCLE_MS || 30 * 60 * 1000);
const STRATEGIES = [moltMarketStrategy, agencStrategy, openTaskStrategy];

function startMarketplaceScheduler(agent) {
  const pipeline = new MarketplacePipeline(agent);
  const opts = {
    minExpectedValue: Number(process.env.MIN_EXPECTED_VALUE_USD || 0),
    maxOpportunities: Number(process.env.MAX_OPPORTUNITIES || 1),
  };

  async function runOneRound() {
    for (const strategy of STRATEGIES) {
      try {
        const cycle = await pipeline.runCycle(strategy, opts);
        if (cycle.status === "completed") {
          console.log(
            `[cycle:${strategy.connectorName}] discovered=${cycle.discovered} accepted=${cycle.accepted} rejected=${cycle.rejected} skippedKnownDead=${cycle.skippedKnownDead}`
          );
        } else if (cycle.status === "skipped_circuit_open") {
          console.log(`[cycle:${strategy.connectorName}] skipped — circuit open (${cycle.kind}), retry in ~${Math.round(cycle.retryAfterMs / 60000)}m`);
        } else {
          console.log(`[cycle:${strategy.connectorName}] ${cycle.status}`);
        }
      } catch (err) {
        // A connector with no credentials, or any other cycle-ending error, is
        // logged once per round rather than crashing the scheduler (and taking
        // the A2A server down with it) or repeating unnecessarily — see
        // learningEngine.js for why this connector may back off further on its own.
        console.error(`[cycle:${strategy.connectorName}] cycle failed: ${err.message}`);
      }
    }
  }

  runOneRound().catch((err) => console.error("initial marketplace round failed:", err.message));
  const timer = setInterval(() => {
    runOneRound().catch((err) => console.error("marketplace scheduler round failed:", err.message));
  }, CYCLE_MS);
  return () => clearInterval(timer);
}

function startTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("TELEGRAM_BOT_TOKEN not set — running without the Telegram approval bot.");
    return null;
  }
  try {
    const TelegramApprovalBot = require("./telegramApprovalBot");
    const bot = new TelegramApprovalBot();
    bot.start().catch((err) => console.error("Telegram bot loop exited unexpectedly:", err.message));
    return bot;
  } catch (err) {
    // A Telegram misconfiguration (missing PERSIST_DIR, empty allow-list, etc.)
    // disables just the bot — it must never take the A2A server down with it.
    console.error(`Telegram bot did not start: ${err.message}`);
    return null;
  }
}

function main() {
  const agent = buildAgent();

  const server = createServer(agent);
  server.listen(PORT, () => {
    console.log(`Combined server listening on port ${PORT} (A2A: POST /a2a, card: GET /.well-known/agent-card.json, health: GET /healthz).`);
  });

  const bot = startTelegramBot();
  const stopScheduler = startMarketplaceScheduler(agent);

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    stopScheduler();
    if (bot) bot.stop();
    server.close(() => process.exit(0));
    // Force-exit if something (e.g. the Telegram long-poll's in-flight request) keeps the event loop alive.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) main();

module.exports = { main, startMarketplaceScheduler, startTelegramBot };
