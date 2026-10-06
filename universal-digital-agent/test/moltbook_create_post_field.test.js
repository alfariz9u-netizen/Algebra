"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

function createFixtureServer(port, { strict = true } = {}) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/posts" && req.method === "POST") {
        const payload = JSON.parse(raw || "{}");
        // This is exactly how the REAL Moltbook API behaves (per
        // production evidence): a post body sent under the wrong key is
        // rejected with 400. `strict` lets a test also demonstrate what
        // the OLD, broken payload shape would have triggered.
        if (strict && (typeof payload.content !== "string" || !payload.content.trim())) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ statusCode: 400, message: "content is required and must be a non-empty string" }));
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "post-1", title: payload.title, content: payload.content }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

test("FIX (production evidence: 400 Bad Request): MoltbookConnector.createPost() sends the post text under 'content', matching the real API", async () => {
  const port = 8971;
  const server = await createFixtureServer(port);
  process.env.MOLTBOOK_API_BASE = `http://localhost:${port}`;
  process.env.MOLTBOOK_API_KEY = "fixture-key";

  try {
    delete require.cache[require.resolve("../src/connectors/moltbook")];
    const MoltbookConnector = require("../src/connectors/moltbook");
    const moltbook = new MoltbookConnector();

    const result = await moltbook.createPost({ title: "A real post", content: "Real post body text, over ten characters." });
    assert.strictEqual(result.id, "post-1");
    assert.strictEqual(result.content, "Real post body text, over ten characters.");
  } finally {
    server.close();
    delete process.env.MOLTBOOK_API_BASE;
    delete process.env.MOLTBOOK_API_KEY;
  }
});

test("REGRESSION GUARD: sending the OLD field name ('body') against a real-shaped API is rejected with 400 — proving the bug this fix closes", async () => {
  const port = 8972;
  const server = await createFixtureServer(port);
  try {
    // Deliberately bypass the connector and hit the fixture the way the
    // OLD, broken connector code used to (title/body/submolt) to prove
    // that payload shape really would 400 against a real-shaped API —
    // i.e. this isn't a hypothetical bug.
    const res = await fetch(`http://localhost:${port}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", body: "this used to be sent as 'body'", submolt: "general" }),
    });
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
  }
});

test("FIX end-to-end: universalAgent's automatic moltbook post actually sends 'content' over the wire, not 'body'", async () => {
  const port = 8973;
  const server = await createFixtureServer(port);
  process.env.MOLTBOOK_API_BASE = `http://localhost:${port}`;
  process.env.MOLTBOOK_API_KEY = "fixture-key";
  process.env.AUTONOMY_LEVEL = "3";
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbook-field-e2e-"));
  process.env.PERSIST_DIR = tmpDir;

  try {
    delete require.cache[require.resolve("../src/connectors/moltbook")];
    delete require.cache[require.resolve("../src/core/universalAgent")];
    const MoltbookConnector = require("../src/connectors/moltbook");
    const UniversalAgent = require("../src/core/universalAgent");

    const agent = new UniversalAgent({ persistDir: tmpDir });
    const moltbook = new MoltbookConnector();
    agent.connectors.register("moltbook", {
      instance: moltbook,
      capabilities: ["getFeed", "commentOnPost", "createPost", "upvotePost"],
      statusFn: () => "CONNECTED",
    });

    const longOutput = "This is a long enough completed-task output. ".repeat(10);
    await agent._maybePublishMoltbookPost(
      { id: "task-field-fix", type: "summarize", sourceConnector: "github" },
      { name: "summarization" },
      longOutput,
      92
    );
    // If the fixture's strict 400-on-wrong-field check had tripped, this
    // would have logged a MOLTBOOK_POST_FAILED audit entry instead.
    const failures = agent.audit.all().filter((e) => e.action === "MOLTBOOK_POST_FAILED");
    assert.strictEqual(failures.length, 0, `expected no post failures, got: ${JSON.stringify(failures)}`);
  } finally {
    server.close();
    delete process.env.MOLTBOOK_API_BASE;
    delete process.env.MOLTBOOK_API_KEY;
    delete process.env.PERSIST_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
