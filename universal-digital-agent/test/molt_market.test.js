"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
function createMoltFixtureServer(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.writeHead(200);
        res.end(JSON.stringify({ safety: { settlement: false }, financial: { ready: false } }));
        return;
      }
      if (req.url === "/agents/register" && req.method === "POST") {
        res.writeHead(201);
        res.end(JSON.stringify({ id: "agent-uuid-1", name: "TestAgent", api_key: "molt_testkey123", skills: ["research"], rating: 0, completed_jobs: 0 }));
        return;
      }
      if (req.url.startsWith("/offers?") && req.method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ offers: [{ id: "offer-1", title: "Compare three competitors", price_usdc: 0.25, version: 1 }] }));
        return;
      }
      if (req.url === "/offers" && req.method === "POST") {
        const parsed = JSON.parse(body);
        res.writeHead(201);
        res.end(JSON.stringify({ id: "offer-2", title: parsed.title, version: 1 }));
        return;
      }
      if (req.url === "/jobs/job-poor/bids" && req.method === "POST") {
        // Simulating the platform's fail-closed behavior: settlement disabled.
        res.writeHead(402);
        res.end(JSON.stringify({ error: "insufficient internal cash" }));
        return;
      }
      if (req.url === "/jobs" && req.method === "POST") {
        const parsed = JSON.parse(body);
        res.writeHead(201);
        res.end(JSON.stringify({ id: "job-1", title: parsed.title, status: "open", funded: false }));
        return;
      }
      if (req.url.match(/\/jobs\/job-1\/bids$/) && req.method === "POST") {
        res.writeHead(201);
        res.end(JSON.stringify({ id: "bid-1", job_id: "job-1", status: "pending" }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found in fixture" }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  const port = 8937;
  const server = await createMoltFixtureServer(port);
  process.env.MOLTMARKET_API_BASE = `http://localhost:${port}`;

  delete require.cache[require.resolve("../src/connectors/moltMarket")];
  const MoltMarketConnector = require("../src/connectors/moltMarket");

  try {
    // Without an API key, status must be honest: CREDENTIAL_REQUIRED.
    delete process.env.MOLTMARKET_API_KEY;
    const connector = new MoltMarketConnector();
    assert.strictEqual(connector.status(), "CREDENTIAL_REQUIRED");
    console.log("PASS: status is CREDENTIAL_REQUIRED with no API key");
    await assert.rejects(() => connector.checkHealth(), /MOLTMARKET_API_KEY is not set/);
    console.log("PASS: requests without a key fail locally instead of going out unauthenticated");

    process.env.MOLTMARKET_API_KEY = "molt_testkey123";
    const authedConnector = new MoltMarketConnector();
    assert.strictEqual(authedConnector.status(), "CONNECTED");
    console.log("PASS: status becomes CONNECTED once an API key is present");

    // checkHealth() probes GET /jobs (there is no /health endpoint on the connector).
    const offers = await authedConnector.browseOffers({ category: "research" });
    assert.ok(offers.offers.length > 0);
    console.log("PASS: browseOffers() returns the offers list");

    const published = await authedConnector.publishOffer({
      title: "Write unit tests",
      description: "Jest tests for an Express API",
      category: "code",
      priceUsdc: 0.25,
      requiredSkills: ["coding"],
    });
    assert.strictEqual(published.title, "Write unit tests");
    console.log("PASS: publishOffer() sends the documented POST /offers shape");

    // A real 402 must surface as an honest error (with status + body), never a fake success.
    await assert.rejects(
      () => authedConnector.bidOnJob("job-poor", { amountUsdc: 1, message: "x" }),
      (err) => err.status === 402 && JSON.stringify(err.body).includes("insufficient internal cash")
    );
    console.log("PASS: a real 402 surfaces as an honest failure, never a fake success");

    const job = await authedConnector.createJob({
      title: "Write unit tests",
      description: "desc",
      category: "code",
      budgetUsdc: 0.05,
      requiredSkills: ["coding"],
    });
    assert.strictEqual(job.funded, false);
    console.log("PASS: createJob() correctly reflects the platform's documented 'unfunded RFP' behavior");

    const bid = await authedConnector.bidOnJob("job-1", { amountUsdc: 0.05, message: "I can do this" });
    assert.strictEqual(bid.job_id, "job-1");
    console.log("PASS: bidOnJob() sends POST /jobs/:id/bids");
  } finally {
    server.close();
  }
}

test("Molt Market connector tests", async () => {
  await main();
});
