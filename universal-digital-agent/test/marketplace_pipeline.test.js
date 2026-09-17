"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
function createCombinedFixtureServer(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      // --- Gemini ---
      if (req.url.includes(":generateContent")) {
        const isQa = body.includes("0-100 integer");
        const text = isQa
          ? '{"score": 90, "reasoning": "Clear, professional bid proposal."}'
          : "I would be glad to take on this job. I have strong relevant experience and can deliver within budget.";
        res.writeHead(200);
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
        return;
      }
      // --- Molt Market: discover open jobs ---
      if (req.url.startsWith("/jobs?") && req.method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ jobs: [{ id: "job-42", title: "Summarize a report", description: "Summarize this quarterly report.", budget_usdc: 0.2 }] }));
        return;
      }
      // --- Molt Market: submit a bid ---
      if (req.url === "/jobs/job-42/bid" && req.method === "POST") {
        res.writeHead(201);
        res.end(JSON.stringify({ id: "bid-99", job_id: "job-42", status: "pending" }));
        return;
      }
      // --- The Colony: share a learning finding ---
      if (req.url === "/posts" && req.method === "POST") {
        res.writeHead(201);
        res.end(JSON.stringify({ id: "post-77" }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found in fixture", url: req.url }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  const port = 8941;
  const server = await createCombinedFixtureServer(port);

  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.MOLTMARKET_API_BASE = `http://localhost:${port}`;
  process.env.MOLTMARKET_API_KEY = "molt_fixturekey";
  process.env.COLONY_API_BASE = `http://localhost:${port}`;
  process.env.COLONY_API_KEY = "col_fixturekey";

  for (const mod of ["../src/core/universalAgent", "../src/connectors/moltMarket", "../src/connectors/colony", "../src/core/marketplacePipeline"]) {
    delete require.cache[require.resolve(mod)];
  }
  const UniversalAgent = require("../src/core/universalAgent");
  const MoltMarketConnector = require("../src/connectors/moltMarket");
  const ColonyConnector = require("../src/connectors/colony");
  const MarketplacePipeline = require("../src/core/marketplacePipeline");
  const moltMarketStrategy = require("../src/core/strategies/moltMarket");

  try {
    // --- Phase 1: at the default MANUAL autonomy level (0), bidding must be held for approval ---
    process.env.AUTONOMY_LEVEL = "0";
    const cautiousAgent = new UniversalAgent();
    const moltMarket1 = new MoltMarketConnector();
    cautiousAgent.connectors.register("moltMarket", {
      instance: moltMarket1,
      capabilities: ["browseJobs", "bidOnJob"],
      statusFn: () => moltMarket1.status(),
    });
    const pipeline1 = new MarketplacePipeline(cautiousAgent);
    const cycle1 = await pipeline1.runCycle(moltMarketStrategy, { minExpectedValue: -1, maxOpportunities: 1 });

    assert.strictEqual(cycle1.status, "completed");
    assert.strictEqual(cycle1.results[0].submission.status, "pending_human_approval");
    console.log("PASS: at autonomy level 0, the pipeline discovers the job but holds the bid for human approval");

    // --- Phase 2: at LIMITED_AUTONOMY (2), the full loop actually runs ---
    process.env.AUTONOMY_LEVEL = "2";
    delete require.cache[require.resolve("../src/core/universalAgent")];
    const UniversalAgent2 = require("../src/core/universalAgent");
    const activeAgent = new UniversalAgent2();

    const moltMarket2 = new MoltMarketConnector();
    activeAgent.connectors.register("moltMarket", {
      instance: moltMarket2,
      capabilities: ["browseJobs", "bidOnJob"],
      statusFn: () => moltMarket2.status(),
    });
    const colony = new ColonyConnector();
    activeAgent.connectors.register("colony", {
      instance: colony,
      capabilities: ["postFinding"],
      statusFn: () => colony.status(),
    });

    const pipeline2 = new MarketplacePipeline(activeAgent);
    const cycle2 = await pipeline2.runCycle(moltMarketStrategy, { minExpectedValue: -1, maxOpportunities: 1 });

    assert.strictEqual(cycle2.accepted, 1, "the job should be accepted as an opportunity");
    const r = cycle2.results[0];
    assert.strictEqual(r.outcome.status, "success", "the bid-drafting task should complete via the real LLM call");
    assert.strictEqual(r.submission.job_id, "job-42", "the bid should actually be submitted to Molt Market");
    console.log("PASS: at autonomy level 2, the pipeline discovers a job, drafts a real bid via the LLM, and submits it");

    assert.strictEqual(r.learning.shared, true, "a successful task should be shared to The Colony for other agents to learn from");
    console.log("PASS: after a successful bid, the agent shares what it learned on The Colony");

    // Confirm the whole thing is properly gated through callConnector: check the audit trail.
    const auditActions = activeAgent.audit.all().map((e) => e.action);
    assert.ok(auditActions.includes("browseJobs"));
    assert.ok(auditActions.includes("bidOnJob"));
    assert.ok(auditActions.includes("postFinding"));
    console.log("PASS: every connector action in the loop passed through the audited callConnector gate");

    const economicsSummary = activeAgent.economics.summary();
    assert.ok(economicsSummary.countsByType.task_discovered >= 1);
    assert.ok(economicsSummary.countsByType.task_accepted >= 1);
    assert.ok(economicsSummary.countsByType.task_completed >= 1);
    console.log("PASS: economic intelligence records the full discover->accept->complete lifecycle");
  } finally {
    server.close();
  }
}

test("Marketplace pipeline integration test", async () => {
  await main();
});
