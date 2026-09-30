"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

delete require.cache[require.resolve("../src/core/universalAgent")];
delete require.cache[require.resolve("../src/core/marketplacePipeline")];
const UniversalAgent = require("../src/core/universalAgent");
const MarketplacePipeline = require("../src/core/marketplacePipeline");

function buildAgentWithFakeColony(postFindingImpl) {
  process.env.AUTONOMY_LEVEL = "3"; // PUBLISH must not need human approval for this test
  process.env.PERSIST_DIR = require("node:fs").mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "colony-429-test-")
  );
  const agent = new UniversalAgent({ persistDir: process.env.PERSIST_DIR });
  agent.connectors.register("colony", {
    instance: { postFinding: postFindingImpl },
    capabilities: ["searchPosts", "postFinding", "commentOnPost", "sendMessage"],
    statusFn: () => "CONNECTED",
  });
  return agent;
}

test("REAL BUG (production evidence 2026-09-30): a 429 from Colony must engage a real backoff, not leave the next attempt free to retry instantly", async () => {
  let calls = 0;
  const agent = buildAgentWithFakeColony(async () => {
    calls += 1;
    const err = new Error(
      'Colony post failed: 429 {"detail":{"message":"An administrator has limited this account to 1 posts per hour.","code":"ADMIN_CAP_REACHED"}}'
    );
    throw err;
  });
  const pipeline = new MarketplacePipeline(agent);

  const first = await pipeline._shareLearning("github", { id: "t1", type: "summarize" }, { capability: "summarization", output: "ok" });
  assert.strictEqual(first.shared, false);
  assert.strictEqual(calls, 1);

  // Immediately after — this is exactly the "two 429s three seconds apart"
  // scenario from the real log. Before this fix, nothing stopped this
  // second call from also hitting the real server and failing again.
  const second = await pipeline._shareLearning("openTask", { id: "t2", type: "summarize" }, { capability: "summarization", output: "ok" });
  assert.strictEqual(second.shared, false);
  assert.strictEqual(calls, 1, "the second attempt must be blocked locally — it must NOT re-call the connector and re-trip the real rate limit");
  assert.match(second.reason, /rate-limit response/);
});

test("A non-429 Colony failure (network blip, auth issue) does NOT trigger the long rate-limit backoff", async () => {
  // Fresh module state — the previous test's 429 set a module-level
  // cooldown that would otherwise leak into this one.
  delete require.cache[require.resolve("../src/core/marketplacePipeline")];
  const FreshPipeline = require("../src/core/marketplacePipeline");

  let calls = 0;
  const agent = buildAgentWithFakeColony(async () => {
    calls += 1;
    throw new Error("ECONNRESET: socket hang up");
  });
  const pipeline = new FreshPipeline(agent);

  const first = await pipeline._shareLearning("github", { id: "t3", type: "summarize" }, { capability: "summarization", output: "ok" });
  assert.strictEqual(first.shared, false);
  assert.strictEqual(calls, 1);

  // Not blocked by the long 429-specific backoff — only the normal short
  // cooldown (6 min default) applies, which a fresh _lastColonyPostAt=0
  // module state won't trip immediately in a real fresh process. Here we
  // only assert it wasn't classified as a rate-limit block.
  const second = await pipeline._shareLearning("openTask", { id: "t4", type: "summarize" }, { capability: "summarization", output: "ok" });
  assert.ok(!second.reason || !/rate-limit response/.test(second.reason));
});

test("REAL BUG (production evidence 2026-09-30): a 429 from Moltbook's auto-post must engage the cooldown, not leave it free to retry instantly", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbook-429-test-"));
  const prevPersist = process.env.PERSIST_DIR;
  process.env.PERSIST_DIR = tmpDir; // isolate from the real ./data and from other tests
  process.env.AUTONOMY_LEVEL = "3";
  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UA = require("../src/core/universalAgent");
  const agent = new UA({ persistDir: tmpDir });

  let createPostCalls = 0;
  const fakeMoltbook = {
    status: () => "CONNECTED",
    createPost: async () => {
      createPostCalls += 1;
      const err = new Error(
        'Moltbook POST /posts failed: 429 {"statusCode":429,"message":"Rate limit exceeded","remaining":0,"reset_at":"2026-09-30T00:43:42.000Z","retry_after_seconds":42}'
      );
      throw err;
    },
    extractChallenge: () => null,
  };
  agent.connectors.register("moltbook", {
    instance: fakeMoltbook,
    capabilities: ["getFeed", "commentOnPost", "createPost", "upvotePost"],
    statusFn: () => "CONNECTED",
  });

  const longOutput = "x".repeat(400); // must clear MOLTBOOK_POST_MIN_OUTPUT_CHARS
  const task1 = { id: "task-a", type: "summarize", sourceConnector: "github" };
  const capability = { name: "summarization" };

  await agent._maybePublishMoltbookPost(task1, capability, longOutput, 90);
  assert.strictEqual(createPostCalls, 1);

  // A second, different completed task moments later — before this fix,
  // lastPostAt was never updated on failure, so this would immediately
  // re-attempt and re-fail against the real (still rate-limited) server.
  const task2 = { id: "task-b", type: "summarize", sourceConnector: "openTask" };
  await agent._maybePublishMoltbookPost(task2, capability, longOutput + " different content entirely", 90);
  assert.strictEqual(createPostCalls, 1, "the cooldown must block the second attempt locally instead of hitting the real API again");

  if (prevPersist === undefined) delete process.env.PERSIST_DIR;
  else process.env.PERSIST_DIR = prevPersist;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
