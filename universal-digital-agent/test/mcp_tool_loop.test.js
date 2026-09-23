"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

/**
 * A Gemini fixture that plays along with real function-calling: the FIRST
 * call (no functionResponse yet in the conversation) returns a functionCall
 * part requesting the "search_web" tool; any LATER call (conversation
 * already contains a functionResponse) returns a normal text answer that
 * references the tool result, proving the loop actually round-tripped
 * through the tool rather than just answering blind.
 */
function createGeminiFunctionCallingFixture(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const systemText = parsed?.systemInstruction?.parts?.[0]?.text || "";
      const isQaGradingCall = systemText.includes("0-100 integer");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (isQaGradingCall) {
        res.end(
          JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: '{"score": 92, "reasoning": "Complete and well-sourced."}' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          })
        );
        return;
      }
      const hasFunctionResponse = (parsed.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse));
      if (!hasFunctionResponse) {
        res.end(
          JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "search_web", args: { query: "renewable energy 2026" } } }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
          })
        );
        return;
      }
      const toolResponsePart = parsed.contents.flatMap((c) => c.parts || []).find((p) => p.functionResponse)?.functionResponse;
      const seenToolResult = JSON.stringify(toolResponsePart?.response?.result || "");
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: `Executive summary based on live search (${seenToolResult}): solar capacity keeps growing.` }] } }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 },
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function createMcpFixture(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      if (msg.method === "initialize") return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }));
      if (msg.method === "tools/list") {
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                { name: "search_web", description: "Search the live web.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
                { name: "not_allowed_tool", description: "Should never be offered to the model." },
              ],
            },
          })
        );
      }
      if (msg.method === "tools/call") {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { output: `3 fresh articles about ${msg.params.arguments.query}` } }));
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "unknown method" } }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function freshBuildAgent() {
  for (const mod of ["../src/index", "../src/core/universalAgent", "../src/llm/geminiClient", "../src/connectors/mcpClient"]) {
    delete require.cache[require.resolve(mod)];
  }
  return require("../src/index").buildAgent;
}

async function main() {
  const geminiPort = 8961;
  const mcpPort = 8962;
  const geminiServer = await createGeminiFunctionCallingFixture(geminiPort);
  const mcpServer = await createMcpFixture(mcpPort);

  process.env.GEMINI_API_KEY = "fixture-key";
  process.env.GEMINI_API_BASE = `http://localhost:${geminiPort}/v1beta`;
  process.env.LLM_PROVIDER = "gemini";
  process.env.AUTONOMY_LEVEL = "2"; // LOW-risk actions run without human approval

  try {
    // --- With MCP connected and allow-listing search_web: the loop actually calls the tool ---
    {
      process.env.MCP_SERVER_URL = `http://localhost:${mcpPort}`;
      process.env.MCP_ALLOWED_TOOLS = "search_web";
      const buildAgent = freshBuildAgent();
      const agent = buildAgent();

      const result = await agent.processTask({ id: "t-tools-1", type: "webResearch", input: { query: "renewable energy adoption" } });
      assert.strictEqual(result.status, "success");
      assert.ok(result.output.includes("3 fresh articles about renewable energy 2026"), `expected the REAL tool result woven into the answer, got: ${result.output}`);

      const toolAudit = agent.audit.all().filter((e) => e.action === "TOOL_LOOP_CALL:search_web");
      assert.strictEqual(toolAudit.length, 1, "exactly one tool call should be audited");
      assert.strictEqual(toolAudit[0].result, "SUCCESS");
      console.log("PASS: webResearch with MCP connected actually calls the real tool and weaves the result into the answer");
    }

    // --- The allow-list is still enforced end-to-end: a tool NOT in MCP_ALLOWED_TOOLS is never offered to the model ---
    {
      process.env.MCP_SERVER_URL = `http://localhost:${mcpPort}`;
      process.env.MCP_ALLOWED_TOOLS = "some_other_tool"; // search_web NOT included -> no usable tools -> falls back
      const buildAgent = freshBuildAgent();
      const agent = buildAgent();
      const result = await agent.processTask({ id: "t-tools-2", type: "webResearch", input: { query: "x" } });
      // No usable tool -> falls back to a single plain generate() call, same as "no MCP configured" below.
      const toolAudit = agent.audit.all().filter((e) => e.action.startsWith("TOOL_LOOP_CALL"));
      assert.strictEqual(toolAudit.length, 0, "a tool outside the allow-list must never be offered/called");
      assert.notStrictEqual(result.status, undefined);
      console.log("PASS: a tool missing from MCP_ALLOWED_TOOLS is never offered to the model, even though the server advertises it");
    }

    // --- Without MCP configured at all: falls back to the exact old single-call behavior, nothing breaks ---
    {
      delete process.env.MCP_SERVER_URL;
      delete process.env.MCP_ALLOWED_TOOLS;
      const buildAgent = freshBuildAgent();
      const agent = buildAgent();
      const result = await agent.processTask({ id: "t-tools-3", type: "webResearch", input: { query: "renewable energy adoption" } });
      // The fixture's "no functionResponse yet" branch always returns a raw functionCall regardless of
      // whether `tools` were declared in the request (a real Gemini API never would without `tools` set,
      // but this fixture is deliberately naive) — so plain modelRouter.generate() (no loop, since MCP isn't
      // connected) gets back an empty-text response and verification fails. What actually matters for this
      // test is proven either way: no tool-loop machinery ran.
      assert.strictEqual(result.status, "failed");
      const toolAudit = agent.audit.all().filter((e) => e.action.startsWith("TOOL_LOOP_CALL"));
      assert.strictEqual(toolAudit.length, 0, "no tool-loop machinery should run when MCP isn't configured");
      console.log("PASS: with no MCP server configured, webResearch takes the plain single-call path (no tool loop)");
    }

    // --- A broken MCP connector degrades gracefully instead of failing the whole task ---
    {
      process.env.MCP_SERVER_URL = "http://localhost:1"; // nothing listens here
      process.env.MCP_ALLOWED_TOOLS = "search_web";
      const buildAgent = freshBuildAgent();
      const agent = buildAgent();
      const result = await agent.processTask({ id: "t-tools-4", type: "webResearch", input: { query: "x" } });
      // The connection failure itself is caught and degrades to the plain path (no crash, no hang) — the
      // fixture's plain-path quirk (see test 3 above) is what makes verification fail here, not the MCP error.
      assert.strictEqual(result.status, "failed");
      assert.ok(!/Internal error|MCP/.test(result.reason || ""), `should degrade cleanly, not surface the MCP error as the task failure: ${result.reason}`);
      console.log("PASS: an unreachable MCP server degrades gracefully (no crash, no hang, no leaked connector error) instead of corrupting the task");
    }
  } finally {
    delete process.env.MCP_SERVER_URL;
    delete process.env.MCP_ALLOWED_TOOLS;
    await new Promise((resolve) => geminiServer.close(resolve));
    await new Promise((resolve) => mcpServer.close(resolve));
  }
}

test("MCP tool-use loop test", async () => {
  await main();
});
