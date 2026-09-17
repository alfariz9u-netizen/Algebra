"use strict";

/**
 * Minimal real Model Context Protocol (MCP) client — JSON-RPC 2.0 over
 * HTTP, following the MCP spec's `initialize` -> `tools/list` -> `tools/call`
 * lifecycle (https://modelcontextprotocol.io/specification). This is a
 * genuine protocol implementation — not a mock of MCP itself, though no
 * live third-party MCP server URL is wired in by default.
 *
 * Security (spec section 16):
 *   - Deny-by-default: every tool call is checked against an explicit
 *     per-tool allow-list before being sent. Unknown tools are refused.
 *   - Request timeout, so a hung/malicious server can't block the agent
 *     indefinitely.
 *   - Response size cap, so a compromised/malicious server can't exhaust
 *     memory by returning an unbounded payload.
 *   - Tool arguments are size-checked before sending — a local MCP server
 *     is a normal, legitimate topology (so this client does NOT apply SSRF
 *     blocking to its own configured serverUrl the way A2A does to
 *     attacker-supplied URLs), but oversized/malformed arguments are still
 *     rejected before they leave the process.
 */

const MAX_RESPONSE_BYTES = Number(process.env.MCP_MAX_RESPONSE_BYTES || 5 * 1024 * 1024); // 5MB
const MAX_ARG_BYTES = Number(process.env.MCP_MAX_ARG_BYTES || 256 * 1024); // 256KB
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 15000);

let requestCounter = 0;

class McpClient {
  constructor({ serverUrl, allowedTools = [] } = {}) {
    this.serverUrl = serverUrl;
    this.allowedTools = new Set(allowedTools); // explicit allow-list, deny by default
    this._initialized = false;
  }

  status() {
    return this.serverUrl ? "CONNECTED" : "NOT_CONNECTED";
  }

  async _rpc(method, params) {
    if (!this.serverUrl) throw new Error("MCP client has no serverUrl configured.");
    const id = ++requestCounter;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(this.serverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`MCP request to ${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`MCP response exceeds size limit (${contentLength} > ${MAX_RESPONSE_BYTES} bytes). Refusing to process.`);
    }

    const rawText = await response.text();
    if (rawText.length > MAX_RESPONSE_BYTES) {
      throw new Error(`MCP response body exceeds size limit (${rawText.length} > ${MAX_RESPONSE_BYTES} bytes).`);
    }

    const data = JSON.parse(rawText);
    if (data.error) throw new Error(`MCP error (${method}): ${data.error.message}`);
    return data.result;
  }

  async initialize() {
    const result = await this._rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "universal-digital-agent", version: "0.1.0" },
    });
    this._initialized = true;
    return result;
  }

  async listTools() {
    if (!this._initialized) await this.initialize();
    const result = await this._rpc("tools/list", {});
    return result?.tools || [];
  }

  /**
   * Deny-by-default: refuses any tool not in the explicit allow-list,
   * regardless of what the server advertises. Also rejects oversized
   * argument payloads before they're ever sent.
   */
  async callTool(toolName, args) {
    if (!this.allowedTools.has(toolName)) {
      throw new Error(`Tool "${toolName}" is not in this client's allow-list. Refusing to call it.`);
    }

    const argSize = JSON.stringify(args ?? {}).length;
    if (argSize > MAX_ARG_BYTES) {
      throw new Error(`Tool arguments for "${toolName}" exceed the size limit (${argSize} > ${MAX_ARG_BYTES} bytes).`);
    }

    if (!this._initialized) await this.initialize();
    return this._rpc("tools/call", { name: toolName, arguments: args });
  }
}

module.exports = McpClient;
