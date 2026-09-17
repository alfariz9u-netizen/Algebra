"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const McpClient = require("../src/connectors/mcpClient");
function createMcpFixtureServer(port, { slow = false, hugeResponse = false } = {}) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const msg = JSON.parse(body);
      if (slow) {
        await new Promise((r) => setTimeout(r, 500));
      }
      res.setHeader("Content-Type", "application/json");
      if (msg.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }));
        return;
      }
      if (msg.method === "tools/list") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "safe_tool" }, { name: "dangerous_tool" }] } }));
        return;
      }
      if (msg.method === "tools/call") {
        if (hugeResponse) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { output: "X".repeat(200) } }));
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { output: `called ${msg.params.name}` } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "unknown method" } }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  const port = 8938;
  const server = await createMcpFixtureServer(port);

  try {
    const client = new McpClient({ serverUrl: `http://localhost:${port}`, allowedTools: ["safe_tool"] });

    // Deny-by-default allow-list.
    await assert.rejects(() => client.callTool("dangerous_tool", {}), /not in this client's allow-list/);
    console.log("PASS: MCP client refuses a tool not in its explicit allow-list, even though the server advertises it");

    const result = await client.callTool("safe_tool", { query: "hello" });
    assert.strictEqual(result.output, "called safe_tool");
    console.log("PASS: MCP client calls an allow-listed tool via real JSON-RPC framing");

    // Oversized argument rejected before ever contacting the server.
    const hugeArgs = { blob: "A".repeat(300000) };
    await assert.rejects(() => client.callTool("safe_tool", hugeArgs), /exceed the size limit/);
    console.log("PASS: oversized tool arguments are rejected before being sent");
  } finally {
    server.close();
  }

  // Response size cap.
  const port2 = 8939;
  const hugeServer = await createMcpFixtureServer(port2, { hugeResponse: false });
  try {
    const client = new McpClient({ serverUrl: `http://localhost:${port2}`, allowedTools: ["safe_tool"] });
    process.env.MCP_MAX_RESPONSE_BYTES = "50"; // artificially tiny for this test
    delete require.cache[require.resolve("../src/connectors/mcpClient")];
    const McpClientReloaded = require("../src/connectors/mcpClient");
    const client2 = new McpClientReloaded({ serverUrl: `http://localhost:${port2}`, allowedTools: ["safe_tool"] });
    await assert.rejects(() => client2.callTool("safe_tool", {}), /exceeds size limit/);
    console.log("PASS: oversized MCP response body is rejected rather than parsed unbounded");
  } finally {
    hugeServer.close();
    delete process.env.MCP_MAX_RESPONSE_BYTES;
  }

  // Timeout on a hung server.
  const port3 = 8940;
  const slowServer = await createMcpFixtureServer(port3, { slow: true });
  try {
    process.env.MCP_REQUEST_TIMEOUT_MS = "100";
    delete require.cache[require.resolve("../src/connectors/mcpClient")];
    const McpClientReloaded = require("../src/connectors/mcpClient");
    const client = new McpClientReloaded({ serverUrl: `http://localhost:${port3}`, allowedTools: ["safe_tool"] });
    await assert.rejects(() => client.callTool("safe_tool", {}), /timed out/);
    console.log("PASS: a hung/slow MCP server is aborted via timeout rather than blocking indefinitely");
  } finally {
    slowServer.close();
    delete process.env.MCP_REQUEST_TIMEOUT_MS;
  }
}

test("MCP client security tests", async () => {
  await main();
});
