"use strict";
/**
 * Moltbook post quality: titles/bodies are LLM-written (ModelRouter.generate)
 * and validated before publishing. The router is stubbed, so no network.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GOOD_TITLE = "Why I stopped trusting github estimates when scoping work";
const GOOD_BODY = Array.from({ length: 110 }, (_, i) => `thought${i}`).join(" ") + "?";
const LONG_OUTPUT = "Detailed result of the task. ".repeat(20);

function setup(t, llmReply) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbook-quality-test-"));
  const prev = { p: process.env.PERSIST_DIR, a: process.env.AUTONOMY_LEVEL };
  process.env.PERSIST_DIR = tmpDir;
  process.env.AUTONOMY_LEVEL = "3";
  t.after(() => {
    if (prev.p === undefined) delete process.env.PERSIST_DIR;
    else process.env.PERSIST_DIR = prev.p;
    if (prev.a === undefined) delete process.env.AUTONOMY_LEVEL;
    else process.env.AUTONOMY_LEVEL = prev.a;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");
  const agent = new UniversalAgent({ persistDir: tmpDir });

  const posts = [];
  agent.connectors.register("moltbook", {
    instance: {
      status: () => "CONNECTED",
      createPost: async (payload) => {
        posts.push(payload);
        return { success: true };
      },
      extractChallenge: () => null,
    },
    capabilities: ["createPost"],
    statusFn: () => "CONNECTED",
  });

  const prompts = [];
  agent.modelRouter.generate = async (system, user) => {
    prompts.push(user);
    return { text: typeof llmReply === "function" ? llmReply() : llmReply };
  };
  return { agent, posts, prompts };
}

const run = (agent, output = LONG_OUTPUT) =>
  agent._maybePublishMoltbookPost(
    { id: "t1", type: "summarize", sourceConnector: "github" },
    { name: "summarization" },
    output,
    92
  );

test("published title has no hash, 'Build log' or 'Bid Proposal'; body has no 'QA score' or 'Budget'", async (t) => {
  const { agent, posts, prompts } = setup(t, JSON.stringify({ title: GOOD_TITLE, body: GOOD_BODY }));
  await run(agent);

  assert.strictEqual(posts.length, 1);
  const { title, content } = posts[0];
  assert.strictEqual(title, GOOD_TITLE);
  assert.ok(!/build log/i.test(title) && !/bid proposal/i.test(title));
  assert.ok(!/#|\b[0-9a-f]{8,}\b|\bhash\b/i.test(title), "no hash in title");
  assert.ok(!/qa score/i.test(content) && !/budget/i.test(content));
  assert.match(prompts[0], /Task: summarize, Connector: github, Capability: summarization/);
});

test("forbidden content from the LLM is rejected, never published", async (t) => {
  const cases = [
    { title: "Build log: summarization on github — 1a2b3c4d5e6f7a8b", body: GOOD_BODY },
    { title: "Bid Proposal: why I think retries hide the real problem", body: GOOD_BODY },
    { title: GOOD_TITLE, body: GOOD_BODY + " My QA score was high." },
    { title: GOOD_TITLE, body: GOOD_BODY + " The Budget was tight." },
    { title: GOOD_TITLE, body: GOOD_BODY + " I am a good fit for this." },
    { title: "Too short", body: GOOD_BODY },
  ];
  for (const c of cases) {
    const { agent, posts } = setup(t, JSON.stringify(c));
    await run(agent);
    assert.strictEqual(posts.length, 0, `should not publish: ${c.title}`);
  }
});

test('{"skip": true} publishes nothing (also inside a code fence)', async (t) => {
  for (const reply of ['{"skip": true}', '```json\n{"skip": true}\n```', "not json at all"]) {
    const { agent, posts } = setup(t, reply);
    await run(agent);
    assert.strictEqual(posts.length, 0);
  }
});

test("output shorter than MOLTBOOK_POST_MIN_OUTPUT_CHARS (150) is skipped before any LLM call", async (t) => {
  const { agent, posts, prompts } = setup(t, JSON.stringify({ title: GOOD_TITLE, body: GOOD_BODY }));
  await run(agent, "x".repeat(149));
  assert.strictEqual(posts.length, 0);
  assert.strictEqual(prompts.length, 0);

  await run(agent, "x".repeat(150));
  assert.strictEqual(posts.length, 1, "exactly 150 chars is enough");
});
