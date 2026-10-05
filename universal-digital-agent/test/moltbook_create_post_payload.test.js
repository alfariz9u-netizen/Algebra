"use strict";
/**
 * REGRESSION: Moltbook POST /posts answered
 *   400 {"message":["property body should not exist"]}
 * because createPost() sent `{ title, body, submolt }`. The API field is
 * `content`. These tests capture the real HTTP request body (global fetch is
 * stubbed) and assert `body` is never sent.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MoltbookConnector = require("../src/connectors/moltbook");

function stubFetch(t, responseJson = { success: true, post: { id: "p1" } }) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, payload: init.body ? JSON.parse(init.body) : undefined });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseJson),
    };
  };
  t.after(() => {
    global.fetch = realFetch;
  });
  return calls;
}

function withApiKey(t) {
  const prev = process.env.MOLTBOOK_API_KEY;
  process.env.MOLTBOOK_API_KEY = "test-key";
  t.after(() => {
    if (prev === undefined) delete process.env.MOLTBOOK_API_KEY;
    else process.env.MOLTBOOK_API_KEY = prev;
  });
}

test("createPost sends `content` and never `body` on the wire", async (t) => {
  withApiKey(t);
  const calls = stubFetch(t);
  const connector = new MoltbookConnector();

  await connector.createPost({ title: "T", content: "Hello world", submolt: "general" });

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /\/posts$/);
  assert.strictEqual(calls[0].init.method, "POST");
  const payload = calls[0].payload;
  assert.ok(!("body" in payload), "payload must NOT contain `body` (server answers 400: property body should not exist)");
  assert.deepStrictEqual(payload, { title: "T", content: "Hello world", submolt: "general" });
});

test("createPost still accepts legacy `body` input but maps it to `content` on the wire", async (t) => {
  withApiKey(t);
  const calls = stubFetch(t);
  const connector = new MoltbookConnector();

  await connector.createPost({ title: "T", body: "legacy caller text" });

  const payload = calls[0].payload;
  assert.ok(!("body" in payload), "legacy `body` input must never be forwarded as `body`");
  assert.strictEqual(payload.content, "legacy caller text");
  assert.strictEqual(payload.submolt, "general");
});

test("createPost rejects empty content / title before any network call", async (t) => {
  withApiKey(t);
  const calls = stubFetch(t);
  const connector = new MoltbookConnector();

  await assert.rejects(() => connector.createPost({ title: "T", content: "   " }), /content is required/);
  await assert.rejects(() => connector.createPost({ title: " ", content: "x" }), /title is required/);
  assert.strictEqual(calls.length, 0);
});

test("universalAgent._maybePublishMoltbookPost sends a request without `body` (end-to-end through the real connector)", async (t) => {
  withApiKey(t);
  const calls = stubFetch(t);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbook-payload-test-"));
  const prevPersist = process.env.PERSIST_DIR;
  const prevAutonomy = process.env.AUTONOMY_LEVEL;
  process.env.PERSIST_DIR = tmpDir;
  process.env.AUTONOMY_LEVEL = "3"; // PUBLISH must not need human approval
  t.after(() => {
    if (prevPersist === undefined) delete process.env.PERSIST_DIR;
    else process.env.PERSIST_DIR = prevPersist;
    if (prevAutonomy === undefined) delete process.env.AUTONOMY_LEVEL;
    else process.env.AUTONOMY_LEVEL = prevAutonomy;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  delete require.cache[require.resolve("../src/core/universalAgent")];
  const UniversalAgent = require("../src/core/universalAgent");
  const agent = new UniversalAgent({ persistDir: tmpDir });
  agent.connectors.register("moltbook", {
    instance: new MoltbookConnector(),
    capabilities: ["getFeed", "commentOnPost", "createPost", "upvotePost", "verifyChallenge"],
    statusFn: () => "CONNECTED",
  });

  const longOutput = "Detailed result of the task. ".repeat(20); // clears MOLTBOOK_POST_MIN_OUTPUT_CHARS
  await agent._maybePublishMoltbookPost(
    { id: "task-1", type: "summarize", sourceConnector: "github" },
    { name: "summarization" },
    longOutput,
    90
  );

  const postCalls = calls.filter((c) => /\/posts$/.test(c.url) && c.init.method === "POST");
  assert.strictEqual(postCalls.length, 1, "exactly one POST /posts request expected");
  const payload = postCalls[0].payload;
  assert.ok(!("body" in payload), "the request sent by universalAgent must not contain `body`");
  assert.strictEqual(typeof payload.content, "string");
  assert.ok(payload.content.includes("Detailed result of the task."), "post text must be carried in `content`");
  assert.strictEqual(payload.submolt, "general");
  assert.ok(payload.title && payload.title.length > 0);
});
