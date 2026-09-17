"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
function createFixtureServer(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.includes(":generateContent")) {
        const isQa = body.includes("0-100 integer");
        const text = isQa
          ? '{"score": 88, "reasoning": "Accurate, well-structured summary."}'
          : "Summary: revenue grew 12% quarter over quarter, driven mainly by the new enterprise tier.";
        res.writeHead(200);
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
        return;
      }
      if (req.url.startsWith("/agents/me/notifications")) {
        res.writeHead(200);
        res.end(JSON.stringify({ notifications: [{ type: "bid_accepted", job_id: "job-77" }, { type: "other_event", job_id: "job-99" }] }));
        return;
      }
      if (req.url === "/jobs/job-77") {
        res.writeHead(200);
        res.end(JSON.stringify({ id: "job-77", title: "Summarize quarterly report", description: "Please summarize the attached quarterly report.", category: "documentProcessing", budget_usdc: 0.2 }));
        return;
      }
      if (req.url === "/jobs/job-77/deliver" && req.method === "POST") {
        const parsed = JSON.parse(body);
        res.writeHead(201);
        res.end(JSON.stringify({ id: "delivery-1", job_id: "job-77", content: parsed.content, status: "submitted" }));
        return;
      }
      if (req.url === "/posts" && req.method === "POST") {
        res.writeHead(201);
        res.end(JSON.stringify({ id: "post-1" }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found in fixture", url: req.url }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  const port = 8942;
  const server = await createFixtureServer(port);

  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.MOLTMARKET_API_BASE = `http://localhost:${port}`;
  process.env.MOLTMARKET_API_KEY = "molt_fixturekey";
  process.env.COLONY_API_BASE = `http://localhost:${port}`;
  process.env.COLONY_API_KEY = "col_fixturekey";
  process.env.AUTONOMY_LEVEL = "2";

  for (const mod of ["../src/core/universalAgent", "../src/connectors/moltMarket", "../src/connectors/colony", "../src/core/marketplacePipeline"]) {
    delete require.cache[require.resolve(mod)];
  }
  const UniversalAgent = require("../src/core/universalAgent");
  const MoltMarketConnector = require("../src/connectors/moltMarket");
  const ColonyConnector = require("../src/connectors/colony");
  const MarketplacePipeline = require("../src/core/marketplacePipeline");

  try {
    const agent = new UniversalAgent();
    const moltMarket = new MoltMarketConnector();
    agent.connectors.register("moltMarket", {
      instance: moltMarket,
      capabilities: ["getMyNotifications", "getJob", "deliverWork"],
      statusFn: () => moltMarket.status(),
    });
    const colony = new ColonyConnector();
    agent.connectors.register("colony", {
      instance: colony,
      capabilities: ["postFinding"],
      statusFn: () => colony.status(),
    });

    const pipeline = new MarketplacePipeline(agent);
    const result = await pipeline.deliverAcceptedMoltMarketJobs({ maxJobs: 5 });

    assert.strictEqual(result.notificationsChecked, 2);
    assert.strictEqual(result.acceptedJobsFound, 1, "only the bid_accepted notification should be treated as work to deliver, not the unrelated other_event one");
    console.log("PASS: notifications are correctly filtered to only genuinely accepted jobs");

    const delivered = result.results[0];
    assert.strictEqual(delivered.outcome.status, "success", "the deliverable should be produced via a real LLM call");
    assert.strictEqual(delivered.submission.job_id, "job-77");
    assert.strictEqual(delivered.submission.status, "submitted");
    console.log("PASS: the deliverable is produced and actually submitted via deliverWork()");

    assert.strictEqual(delivered.learning.shared, true);
    console.log("PASS: learning is shared to The Colony after a successful delivery");

    const revenue = agent.economics.summary().totalRevenueUsd;
    assert.strictEqual(revenue, 0.2);
    console.log("PASS: economic intelligence records the real revenue from the job's budget");
  } finally {
    server.close();
  }
}

test("Molt Market post-acceptance delivery test", async () => {
  await main();
});
