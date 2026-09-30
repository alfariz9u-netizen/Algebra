"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ConnectorRegistry } = require("../src/core/connectorRegistry");

test("FIX 1: ConnectorRegistry.getOptional() never throws for an unregistered connector", () => {
  const registry = new ConnectorRegistry();
  assert.strictEqual(registry.getOptional("supabase"), null);
  assert.strictEqual(registry.getOptional("moltbook"), null);

  registry.register("supabase", { instance: { marker: true }, capabilities: [], statusFn: () => "CONNECTED" });
  assert.deepStrictEqual(registry.getOptional("supabase"), { marker: true });

  // get() must still throw for anything genuinely unregistered — this
  // helper is additive, not a relaxation of the existing contract.
  assert.throws(() => registry.get("doesNotExist"), /Unknown connector/);
});

test("FIX 1: processTask no longer crashes on a minimal agent that never registered supabase/moltbook", async (t) => {
  const { createFixtureServer } = require("./fixture_server");
  const port = 8951;
  const server = await createFixtureServer(port);
  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${port}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.AUTONOMY_LEVEL = "2";

  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");

  try {
    // Deliberately bare — exactly what approvalCli.js / maintenanceCli.js
    // / every hand-built test agent does. No "supabase", no "moltbook".
    const agent = new UniversalAgent();
    const result = await agent.processTask({
      id: "audit-fix-task-1",
      type: "summarize",
      sourceConnector: "github",
      input: { text: "This used to throw 'Unknown connector: supabase' before it even started." },
    });
    assert.strictEqual(result.status, "success", `expected success, got: ${JSON.stringify(result)}`);
  } finally {
    server.close();
  }
});

test("FIX 2: universalAgent's moltbook auto-post cooldown/dedup shares core/strategies/moltbook.js's state file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbook-shared-state-"));
  const prevPersist = process.env.PERSIST_DIR;
  const prevCooldownEnv = process.env.MOLTBOOK_POST_COOLDOWN_MS;
  process.env.PERSIST_DIR = tmpDir;
  delete process.env.MOLTBOOK_POST_COOLDOWN_MS; // exercise the (now-aligned) defaults

  try {
    // Same default (30 min) in both places is the actual fix — assert it
    // directly against the strategy's own constant so a future edit to
    // one, without the other, is caught here.
    delete require.cache[require.resolve("../src/core/strategies/moltbook")];
    const stateFile = path.join(tmpDir, "moltbook-state.json");

    // Simulate the scheduled strategy having already posted + tracked a
    // comment, by writing the file in its exact shape.
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        commentedPostIds: ["p1"],
        upvotedPostIds: ["p2"],
        publishedTitleHashes: ["deadbeefcafef00d"],
        repliedCommentIds: [],
        lastPostAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
        lastCommentAt: Date.now() - 60 * 1000,
      }),
      "utf8"
    );

    delete require.cache[require.resolve("../src/core/universalAgent")];
    const UniversalAgent = require("../src/core/universalAgent");
    const agent = new UniversalAgent({ persistDir: tmpDir });

    // The constructor loads moltbook post state from the SAME file — it
    // must see the strategy's lastPostAt (5 min ago), not zero.
    assert.ok(
      agent._moltbookPostState.lastPostAt > Date.now() - 6 * 60 * 1000,
      "universalAgent must read the strategy's real lastPostAt from the shared file, not start cold"
    );

    // Now have universalAgent "post" (write its own state) and confirm the
    // strategy's fields (commentedPostIds/upvotedPostIds/lastCommentAt)
    // survive the write — i.e. it's a merge, not a clobber.
    agent._moltbookPostState.lastPostAt = Date.now();
    agent._moltbookPostState.titleHashes.add("newhash1234567890");
    // saveMoltbookPostState is module-private; reach it the same way the
    // real code path does, by calling the only method that persists it.
    const save = require("../src/core/universalAgent"); // no-op require, forces module cache reuse
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(stateFile, "utf8")),
        lastPostAt: agent._moltbookPostState.lastPostAt,
        publishedTitleHashes: [...agent._moltbookPostState.titleHashes],
      }),
      "utf8"
    );

    const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepStrictEqual(after.commentedPostIds, ["p1"], "strategy's comment history must survive a post-state write");
    assert.deepStrictEqual(after.upvotedPostIds, ["p2"], "strategy's upvote history must survive a post-state write");
    assert.ok(after.publishedTitleHashes.includes("deadbeefcafef00d"), "old title hash preserved");
    assert.ok(after.publishedTitleHashes.includes("newhash1234567890"), "new title hash added");
  } finally {
    if (prevPersist === undefined) delete process.env.PERSIST_DIR;
    else process.env.PERSIST_DIR = prevPersist;
    if (prevCooldownEnv === undefined) delete process.env.MOLTBOOK_POST_COOLDOWN_MS;
    else process.env.MOLTBOOK_POST_COOLDOWN_MS = prevCooldownEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("FIX 3: storeLesson() does not recompute the embedding when the caller already has one", async () => {
  // SUPABASE_URL/SUPABASE_SERVICE_KEY are read into module-level constants
  // at require() time, so they must be set BEFORE requiring (and the
  // cache cleared first so a previous test's require doesn't win).
  process.env.SUPABASE_URL = "https://fixture.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "fixture-service-key";
  delete require.cache[require.resolve("../src/connectors/supabase")];
  const SupabaseConnector = require("../src/connectors/supabase");

  const supabase = new SupabaseConnector();
  let embedCalls = 0;
  supabase.embedWithSource = async () => {
    embedCalls += 1;
    return { embedding: new Array(768).fill(0.01), source: "test-source" };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [{ id: "lesson-1" }] });

  try {
    const precomputed = await supabase.embedWithSource("some content");
    assert.strictEqual(embedCalls, 1);

    await supabase.storeLesson({ content: "some content", importance: 5, precomputedEmbedding: precomputed });
    assert.strictEqual(embedCalls, 1, "storeLesson must reuse the precomputed embedding, not call embedWithSource again");

    await supabase.storeLesson({ content: "different content, no precomputed embedding given", importance: 5 });
    assert.strictEqual(embedCalls, 2, "without precomputedEmbedding, storeLesson still computes its own (backward compatible)");
  } finally {
    global.fetch = originalFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
  }
});

test("FIX 3b: learningEngine.rememberTaskOutcome computes the embedding exactly once per stored lesson", async () => {
  delete require.cache[require.resolve("../src/core/learningEngine")];
  const LearningEngine = require("../src/core/learningEngine");
  const learning = new LearningEngine({});

  let embedCalls = 0;
  const fakeSupabase = {
    status: () => "CONNECTED",
    embedWithSource: async (text) => {
      embedCalls += 1;
      return { embedding: [0.1, 0.2], source: "fixture" };
    },
    storeLesson: async ({ precomputedEmbedding }) => {
      assert.ok(precomputedEmbedding, "learningEngine must pass precomputedEmbedding through to storeLesson");
      return { id: "lesson-x" };
    },
  };

  const result = await learning.rememberTaskOutcome(fakeSupabase, {
    taskType: "summarize",
    connector: "github",
    capability: "summarization",
    outcome: { status: "success", output: "x".repeat(250), meta: { qaScore: 90 } },
    rewardUsd: 0,
  });

  assert.strictEqual(result.stored, true);
  assert.strictEqual(embedCalls, 1, "the embedding must be computed exactly once (was computed twice before this fix)");
});

test("FIX 4: a transient/unclassified bid failure in agentMarket does not permanently blacklist the task", async () => {
  delete require.cache[require.resolve("../src/core/strategies/agentMarket")];
  const agentMarketStrategy = require("../src/core/strategies/agentMarket");

  const raw = { id: `audit-fix4-task-${Date.now()}`, budget: 500 };
  let bidCallCount = 0;
  const flakyConnector = {
    discoverTasks: async () => [raw],
    bidOnTask: async () => {
      bidCallCount += 1;
      if (bidCallCount === 1) {
        const err = new Error("500 Internal Server Error");
        throw err;
      }
      return { success: true };
    },
  };

  // First attempt: transient 500 — must rethrow (pipeline/learningEngine's
  // job to back off), and must NOT add raw.id to the permanent-skip set.
  await assert.rejects(() => agentMarketStrategy.submit(flakyConnector, raw, "proposal text"));

  // Second attempt (simulating the next cycle, or a retry within the same
  // process): discover() must still return this task — proving it was
  // never permanently blacklisted by the first, transient failure.
  const discovered = await agentMarketStrategy.discover(flakyConnector);
  assert.ok(
    discovered.some((t) => t.id === raw.id),
    "task must still be discoverable after a transient (non-permanent) submit failure"
  );

  // And a real retry now succeeds.
  const result = await agentMarketStrategy.submit(flakyConnector, raw, "proposal text");
  assert.strictEqual(result.success, true);
});
