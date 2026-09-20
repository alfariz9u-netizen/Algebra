"use strict";
/**
 * Render-compatible entry point.
 * Render's free Web Service requires the app to listen on process.env.PORT
 * so its health check passes. This project has no HTTP server by default
 * (it's a long-polling Telegram bot), so this tiny wrapper adds one and
 * starts the real bot alongside it.
 *
 * It also exposes a one-time helper route, /register-toku, that performs
 * the toku.agency agent-registration POST server-side (avoiding browser
 * CORS restrictions). Protected by a secret in the URL. Delete this route
 * (revert to the clean server.js) once you've saved the returned apiKey.
 */
const http = require("http");

const REGISTER_SECRET = "uda-9f2k7q";

const PORT = process.env.PORT || 3000;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/register-toku") {
      if (url.searchParams.get("secret") !== REGISTER_SECRET) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden.\n");
        return;
      }
      try {
        const name = url.searchParams.get("name") || "UniversalDigitalAgent";
        const upstream = await fetch("https://www.toku.agency/api/agents/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            description: "General-purpose autonomous research and coding agent.",
          }),
        });
        const text = await upstream.text();
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Status: ${upstream.status}\n\n${text}\n`);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Error: ${err.message}\n`);
      }
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
