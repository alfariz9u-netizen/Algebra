"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const EconomicIntelligence = require("../src/core/economicIntelligence");
const LearningEngine = require("../src/core/learningEngine");
const AgentBrain = require("../src/core/agentBrain");
const UniversalAgent = require("../src/core/universalAgent");
const MarketplacePipeline = require("../src/core/marketplacePipeline");
const { expectedValue } = require("../src/core/opportunityEngine");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24);

function setup() {
  const economics = new EconomicIntelligence({ strictRevenue: true, supabase: { enabled: false } });
  const learning = new LearningEngine({ supabase: { enabled: false } });
  const brain = new AgentBrain({ economics, learning, now: () => NOW });
  return { economics, learning, brain };
}

function deliver(economics, connector, i, { expected = 1, ageDays = 10 } = {}) {
  economics.record({ type: "task_completed", taskId: `${connector}-${i}`, connector, expectedRevenueUsd: expected, costUsd: 0, tokenUsage: 500, timestamp: NOW - ageDays * DAY });
}

test("fake profit: expected reward is never income; only confirmed payments count, attributed by task", () => {
  const { economics } = setup();
  deliver(economics, "openTask", 1, { expected: 5 });
  deliver(economics, "openTask", 2, { expected: 5 });
  assert.strictEqual(economics.summary().totalProfitUsd, 0);
  economics.recordPayment({ taskId: "openTask-1", amountUsd: 4, txSignature: "0xabc" }); // no connector on the payment: resolved via its task
  const perf = economics.connectorPerformance({ now: NOW }).openTask;
  assert.strictEqual(perf.paidUsd, 4);
  assert.strictEqual(perf.expectedUsd, 10);
  assert.strictEqual(perf.realizationRate, 0.4);
  assert.strictEqual(economics.overdueExpectedUsd({ now: NOW }), 5); // the unpaid one, past grace
  assert.strictEqual(economics.summary().totalProfitUsd, 4);
  assert.strictEqual(economics.bestPlatform().connector, "openTask");
});

test("per-connector lifetime facts survive pruning", () => {
  const { economics } = setup();
  deliver(economics, "agenc", 1, { expected: 2 });
  economics.recordPayment({ taskId: "agenc-1", amountUsd: 2, txSignature: "0x1" });
  economics.prune({ maxEntries: 0 + 1 }); // keep 1 event, fold the rest
  const perf = economics.connectorPerformance({ now: NOW }).agenc;
  assert.strictEqual(perf.paidUsd, 2);
  assert.strictEqual(perf.completed, 1);
});

test("realization: thin data -> prior; unpaid history lowers trust; paid history raises it", () => {
  const { economics, brain } = setup();
  assert.strictEqual(brain.realizationRate("nobody"), 0.5);
  for (let i = 0; i < 10; i++) deliver(economics, "ghost", i);
  for (let i = 0; i < 10; i++) deliver(economics, "payer", i);
  for (let i = 0; i < 10; i++) economics.recordPayment({ taskId: `payer-${i}`, amountUsd: 1, txSignature: `0xp${i}` });
  assert.ok(brain.realizationRate("ghost") < 0.1, "never-paid connector must be heavily discounted");
  assert.ok(brain.realizationRate("payer") > 0.9, "reliably-paying connector must be trusted");
  const base = { rewardUsd: 10, successProbability: 0.5, estimatedModelCostUsd: 0, platformFeeUsd: 0 };
  assert.strictEqual(expectedValue({ ...base }), 5);
  assert.ok(expectedValue({ ...base, realizationRate: brain.realizationRate("ghost") }) < 0.5);
});

test("token waste: a connector with many deliveries and $0 paid is throttled, probed occasionally", () => {
  const { economics, brain } = setup();
  for (let i = 0; i < 10; i++) deliver(economics, "ghost", i);
  const modes = [1, 2, 3, 4, 5].map(() => brain.planCycle({ connectorName: "ghost" }, { maxOpportunities: 2 }));
  assert.deepStrictEqual(modes.map((m) => m.mode), ["probe", "throttled", "throttled", "throttled", "probe"]);
  assert.strictEqual(modes[0].maxOpportunities, 1);
  assert.strictEqual(modes[1].run, false);
});

test("exploration, reputation exemption and bid patience", () => {
  const { economics, learning, brain } = setup();
  assert.strictEqual(brain.planCycle({ connectorName: "new" }, { maxOpportunities: 2 }).mode, "explore");
  for (let i = 0; i < 10; i++) deliver(economics, "social", i);
  assert.strictEqual(brain.planCycle({ connectorName: "social", reputationOnly: true }, {}).run, true);
  for (let i = 0; i < 24; i++) learning.recordAttempt("bidder", { won: false });
  assert.strictEqual(brain.planCycle({ connectorName: "bidder" }, {}).mode, "probe");
  assert.strictEqual(brain.planCycle({ connectorName: "bidder" }, {}).run, false);
  learning.recordWin("bidder"); // one observed acceptance clears the suspicion
  assert.notStrictEqual(brain.planCycle({ connectorName: "bidder" }, {}).mode, "throttled");
});

test("learning: re-posted listing (new id, same text) is recognised; lessons merge and recall", () => {
  const { learning } = setup();
  learning.markContentSeen("c", "Build a Telegram bot for restaurant orders 2026-11-01", "id-1");
  assert.ok(learning.isContentSeen("c", "build a TELEGRAM bot for restaurant orders (2026-11-24)"));
  assert.ok(!learning.isContentSeen("c", "Translate a legal contract into German"));
  const { fresh, duplicates } = learning.partitionDuplicateContent("c", [{ t: "Build a Telegram bot for restaurant orders" }, { t: "Write a poem about the sea and sky" }, { t: "Write a poem about the sea and sky!" }], (o) => o.t);
  assert.strictEqual(fresh.length, 1); // batch-internal duplicate removed too
  assert.strictEqual(duplicates.length, 2);

  assert.strictEqual(learning.addLocalLesson({ kind: "negative", connector: "c", text: "Proposal was rejected: too generic and ignored the budget" }).stored, true);
  assert.strictEqual(learning.addLocalLesson({ kind: "negative", connector: "c", text: "Proposal was rejected: too generic and ignored the budget" }).merged, true);
  const r = learning.recallLocalLessons("write a generic proposal ignoring budget", { connector: "c" });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].kind, "negative");
});

test("pipeline: the same job re-posted under a new id is not drafted (no LLM tokens) a second time", async () => {
  const agent = new UniversalAgent({});
  agent.autonomyLevel = 3;
  let llmCalls = 0;
  agent.processTask = async () => { llmCalls++; return { status: "success", output: "proposal text", meta: { tokenUsage: 300, costUsd: 0 } }; };
  agent.callConnector = async (_c, _o, _p, fn) => fn();
  agent.connectors.status = () => "NOT_CONNECTED";
  agent.connectors.get = () => ({});
  let listing = [{ id: "A1", title: "Scrape product pages into CSV", description: "Need python scraper for 200 product pages", budget: 20 }];
  const strategy = {
    connectorName: "fake", discoverOperation: "discover", discoverPermission: "READ_PUBLIC_WEB", submitOperation: "submit", submitPermission: "SUBMIT_TASK",
    discover: async () => listing,
    toOpportunity: (raw) => ({ id: raw.id, type: "job", rewardUsd: raw.budget, successProbability: 0.5 }),
    toTask: (raw) => ({ id: `fake-${raw.id}`, type: "communication", input: { goal: raw.title } }),
    submit: async () => ({ ok: true }),
  };
  const pipeline = new MarketplacePipeline(agent);
  const c1 = await pipeline.runCycle(strategy, { maxOpportunities: 2 });
  assert.strictEqual(c1.results.length, 1);
  listing = [{ id: "A2", title: "Scrape product pages into CSV", description: "Need python scraper for 200 product pages", budget: 20 }]; // re-post, new id
  const c2 = await pipeline.runCycle(strategy, { maxOpportunities: 2 });
  assert.strictEqual(c2.skippedDuplicateContent, 1);
  assert.strictEqual(c2.results.length, 0);
  assert.strictEqual(llmCalls, 1);
  // and the ledger never claimed money: a bid is not income
  assert.strictEqual(agent.economics.summary().totalRevenueUsd, 0);
  assert.ok(agent.dashboard().brain.connectors.fake);
});
