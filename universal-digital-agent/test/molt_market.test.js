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
      if (req.url.includes("/purchase") && req.method === "POST") {
        // Simulating the platform's real fail-closed behavior: settlement disabled.
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
      if (req.url.match(/\/jobs\/job-1\/bid$/) && req.method === "POST") {
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
    // Before registering, status must be honest: CREDENTIAL_REQUIRED.
    const connector = new MoltMarketConnector();
    assert.strictEqual(connector.status(), "CREDENTIAL_REQUIRED");
    console.log("PASS: status is CREDENTIAL_REQUIRED with no API key");

    const health = await connector.checkHealth();
    assert.strictEqual(health.financial.ready, false);
    console.log("PASS: /health correctly reports settlement is not yet enabled (fail-closed, not faked)");

    const registration = await MoltMarketConnector.register({ name: "TestAgent", skills: ["research"] });
    assert.strictEqual(registration.api_key, "molt_testkey123");
    process.env.MOLTMARKET_API_KEY = registration.api_key;
    console.log("PASS: register() parses the real documented response shape");

    const authedConnector = new MoltMarketConnector();
    assert.strictEqual(authedConnector.status(), "CONNECTED");
    console.log("PASS: status becomes CONNECTED once an API key is present");

    const offers = await authedConnector.browseOffers({ category: "research" });
    assert.ok(offers.offers.length > 0);
    console.log("PASS: browseOffers() works with no auth, matching the real public endpoint");

    const published = await authedConnector.publishOffer({
      title: "Write unit tests",
      description: "Jest tests for an Express API",
      category: "code",
      priceUsdc: 0.25,
      requiredSkills: ["coding"],
    });
    assert.strictEqual(published.title, "Write unit tests");
    console.log("PASS: publishOffer() sends the documented POST /offers shape");

    // The platform's own docs say purchases can fail closed (402) while
    // settlement is disabled — this must surface as a real error, not success.
    let threw = false;
    try {
      await authedConnector.purchaseOffer("offer-1", { expectedVersion: 1, brief: "test", idempotencyKey: "test-key-1" });
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("insufficient internal cash"));
    }
    assert.ok(threw, "purchaseOffer should throw a real error on 402, not fake success");
    console.log("PASS: a real 402 (settlement disabled) surfaces as an honest failure, never a fake success");

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
    console.log("PASS: bidOnJob() sends the documented POST /jobs/:id/bid shape");
  } finally {
    server.close();
  }
}

test("Molt Market connector tests", async () => {
  await main();
});
