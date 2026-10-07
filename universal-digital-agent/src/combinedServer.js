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
 *      observed in production). All strategies this project has today
 *      are included below; add more to STRATEGIES as they're built.
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
 * that's keeping Render awake. Same isolation applies PER STRATEGY inside
 * the scheduler itself: one connector with no credentials, or a circuit
 * the learning engine has opened, never stops the other six from running
 * their cycle this round.
 */

const { buildAgent } = require("./index");
const { createServer } = require("./a2aServer");
const MarketplacePipeline = require("./core/marketplacePipeline");
const moltMarketStrategy = require("./core/strategies/moltMarket");
const agencStrategy = require("./core/strategies/agenc");
const openTaskStrategy = require("./core/strategies/openTask");
const moltJobsStrategy = require("./core/strategies/moltJobs");
const agentMarketStrategy = require("./core/strategies/agentMarket");
const githubBountiesStrategy = require("./core/strategies/githubBounties");
const tokuAgencyStrategy = require("./core/strategies/tokuAgency");
const moltbookStrategy = require("./core/strategies/moltbook"); // ← جديد: بناء السمعة
// This strategy file existed already (a full, working discovery/pricing
// engine) but was never added to STRATEGIES below, so it never ran —
// confirmed via live logs showing no "[cycle:agentBazaar]" entries ever,
// and agentBazaar.js's status() previously requiring a wallet for its
// free discovery operation too (now fixed — see connectors/agentBazaar.js).
const agentBazaarStrategy = require("./core/strategies/agentBazaar");

// Render sets PORT itself; A2A_SERVER_PORT is honored too for parity with a2aServer.js run standalone.
const PORT = Number(process.env.PORT || process.env.A2A_SERVER_PORT || 8787);
const CYCLE_MS = Number(process.env.MARKETPLACE_CYCLE_MS || 30 * 60 * 1000);
// Real revenue confirmation (see paymentWatcher.js and
// economicIntelligence.recordPayment()). Every 5 minutes by default — far
// more frequent than the 24h lookback window that gets re-scanned each
// time, so a payment is confirmed in the dashboard well before the day's
// window would otherwise roll past it. recordPayment()'s own
// txSignature-based idempotency is what makes the repeated re-scanning
// safe (see the tests in payment_watcher.test.js).
const PAYMENT_WATCH_CYCLE_MS = Number(process.env.PAYMENT_WATCH_CYCLE_MS || 5 * 60 * 1000);

// moltbookStrategy is appended last: it is pure reputation-building
// (rewardUsd=0, reputationValue>0), so it should not displace or delay
// any of the earning strategies above it in a single round. It also uses
// its own MOLTBOOK_POSTS_PER_CYCLE (default 3) to bound how many posts
// it engages with per cycle, independent of MAX_OPPORTUNITIES.
const STRATEGIES = [
  moltMarketStrategy,
  agencStrategy,
  openTaskStrategy,
  moltJobsStrategy,
  agentMarketStrategy,
  githubBountiesStrategy,
  tokuAgencyStrategy,
  agentBazaarStrategy, // ← جديد: كان جاهزًا بالكامل، لم يُفعَّل قط
  moltbookStrategy, // ← جديد
];

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

/**
 * Starts the real-payment confirmation loop. Only actually scans a
 * network once a wallet address is configured for it
 * (PAYMENT_WALLET_SOLANA / PAYMENT_WALLET_BASE) — with neither set, this
 * runs every cycle, finds nothing to scan, and is a no-op, so it's always
 * safe to start. Never throws into the caller — a real RPC outage or
 * misconfiguration is logged and retried next cycle, not fatal to the
 * rest of the server.
 */
function startPaymentWatcher(agent) {
  const { runPaymentWatchCycle } = require("./core/paymentWatcher");

  async function runOneCycle() {
    const result = await runPaymentWatchCycle(agent.economics);
    if (result.scanned.length === 0) return; // no wallet configured — nothing to do, no need to log every 5 minutes
    for (const s of result.scanned) {
      console.log(`[paymentWatcher] ${s.network} (${s.walletAddress}): found ${s.found} transfer(s) in the lookback window.`);
    }
    if (result.recorded > 0) console.log(`[paymentWatcher] recorded ${result.recorded} new confirmed payment(s).`);
    for (const e of result.errors) {
      console.error(`[paymentWatcher] ${e.network} scan failed (will retry next cycle): ${e.error}`);
    }
  }

  runOneCycle().catch((err) => console.error("[paymentWatcher] initial cycle failed:", err.message));
  const timer = setInterval(() => {
    runOneCycle().catch((err) => console.error("[paymentWatcher] cycle failed:", err.message));
  }, PAYMENT_WATCH_CYCLE_MS);
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

/**
 * Registers this agent on Agentverse once at boot. Fire-and-forget: per
 * uagents-core's own docs, v2 registrations are permanent ("no need for
 * periodic refresh") — calling it again on every restart just updates
 * the same listing (harmless), and if AGENTVERSE_API_KEY/AGENTVERSE_
 * AGENT_SEED aren't set, status() reports CREDENTIAL_REQUIRED and this
 * is skipped with a log line, not a crash. Never blocks server startup.
 */
async function maybeRegisterOnAgentverse(agent) {
  const agentverse = agent.connectors.getOptional
    ? agent.connectors.getOptional("agentverse")
    : null;
  if (!agentverse || agentverse.status("register") !== "CONNECTED") {
    console.log("[agentverse] skipped registration (CREDENTIAL_REQUIRED — set AGENTVERSE_API_KEY + AGENTVERSE_AGENT_SEED to enable).");
    return;
  }
  try {
    const result = await agentverse.register({});
    console.log(`[agentverse] registered/updated listing: address=${result.address} url=${result.url}`);
  } catch (err) {
    console.warn(`[agentverse] registration failed (non-fatal): ${err.message}`);
  }
}

function main() {
  const agent = buildAgent();

  const server = createServer(agent);
  server.listen(PORT, () => {
    console.log(`Combined server listening on port ${PORT} (A2A: POST /a2a, card: GET /.well-known/agent-card.json, health: GET /healthz).`);
    console.log(`Auto-run scheduler enabled: every ${Math.round(CYCLE_MS / 60000)}m, strategies: ${STRATEGIES.map((s) => s.connectorName).join(", ")}`);
  });
  maybeRegisterOnAgentverse(agent);

  const bot = startTelegramBot();
  const stopScheduler = startMarketplaceScheduler(agent);
  const stopPaymentWatcher = startPaymentWatcher(agent);

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    stopScheduler();
    stopPaymentWatcher();
    if (bot) bot.stop();
    server.close(() => process.exit(0));
    // Force-exit if something (e.g. the Telegram long-poll's in-flight request) keeps the event loop alive.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) main();

module.exports = { main, startMarketplaceScheduler, startTelegramBot, startPaymentWatcher };
