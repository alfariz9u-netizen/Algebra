"use strict";
/**
 * Render-compatible entry point.
 * Render's free Web Service requires the app to listen on process.env.PORT
 * so its health check passes. This project has no HTTP server by default
 * (it's a long-polling Telegram bot), so this tiny wrapper adds one and
 * starts the real bot alongside it.
 *
 * It also exposes a one-time helper route, /verify-connectors, that makes
 * a real, read-only API call to each connected platform (GitHub, The
 * Colony, OpenTask, Molt Market) to confirm the stored keys and fixed
 * endpoints actually work. No writes, no posts, no side effects.
 * Protected by a secret in the URL.
 */
const http = require("http");

const VERIFY_SECRET = "uda-9f2k7q";

const PORT = process.env.PORT || 3000;

async function verifyConnectors() {
  const results = {};

  // GitHub — read the repo the token is scoped to
  if (process.env.GITHUB_TOKEN) {
    try {
      const res = await fetch("https://api.github.com/repos/alfariz9u-netizen/Algebra", {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      });
      results.github = res.ok
        ? { ok: true, detail: `read repo OK (HTTP ${res.status})` }
        : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      results.github = { ok: false, detail: err.message };
    }
  } else {
    results.github = { ok: false, detail: "GITHUB_TOKEN not set" };
  }

  // The Colony — corrected endpoint: /search with colony_name (optional) + sort
  if (process.env.COLONY_API_KEY) {
    try {
      const url = new URL("https://thecolony.cc/api/v1/search");
      url.searchParams.set("q", "test");
      url.searchParams.set("sort", "relevance");
      url.searchParams.set("limit", "1");
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.COLONY_API_KEY}` },
      });
      const text = await res.text();
      results.colony = res.ok
        ? { ok: true, detail: `search OK (HTTP ${res.status})` }
        : { ok: false, detail: `HTTP ${res.status} - ${text.slice(0, 200)}` };
    } catch (err) {
      results.colony = { ok: false, detail: err.message };
    }
  } else {
    results.colony = { ok: false, detail: "COLONY_API_KEY not set" };
  }

  // OpenTask — corrected base: /api/tasks (no /v1)
  if (process.env.OPENTASK_API_KEY) {
    try {
      const url = new URL("https://opentask.ai/api/tasks");
      url.searchParams.set("status", "open");
      url.searchParams.set("limit", "1");
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.OPENTASK_API_KEY}` },
      });
      const text = await res.text();
      results.openTask = res.ok
        ? { ok: true, detail: `list tasks OK (HTTP ${res.status})` }
        : { ok: false, detail: `HTTP ${res.status} - ${text.slice(0, 200)}` };
    } catch (err) {
      results.openTask = { ok: false, detail: err.message };
    }
  } else {
    results.openTask = { ok: false, detail: "OPENTASK_API_KEY not set" };
  }

  // Molt Market — already confirmed working, re-check anyway
  if (process.env.MOLTMARKET_API_KEY) {
    try {
      const url = new URL("https://moltmarket.store/notifications");
      url.searchParams.set("unread_only", "false");
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.MOLTMARKET_API_KEY}` },
      });
      results.moltMarket = res.ok
        ? { ok: true, detail: `read notifications OK (HTTP ${res.status})` }
        : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      results.moltMarket = { ok: false, detail: err.message };
    }
  } else {
    results.moltMarket = { ok: false, detail: "MOLTMARKET_API_KEY not set" };
  }

  return results;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/verify-connectors") {
      if (url.searchParams.get("secret") !== VERIFY_SECRET) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden.\n");
        return;
      }
      const results = await verifyConnectors();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(results, null, 2));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("universal-digital-agent: alive\n");
  })
  .listen(PORT, () => {
    console.log(`Health-check server listening on port ${PORT}`);
  });

const TelegramApprovalBot = require("./src/telegramApprovalBot");

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.log("TELEGRAM_BOT_TOKEN not set - health server running, bot not started.");
} else {
  const bot = new TelegramApprovalBot();
  console.log(`Telegram approval bot starting (allowlist: ${[...bot.allowedChatIds].join(", ")})...`);
  bot.start().catch((err) => {
    console.error("Bot crashed:", err);
  });
}
