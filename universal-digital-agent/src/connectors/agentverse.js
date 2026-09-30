"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

/**
 * Agentverse (Fetch.ai) connector.
 *
 * WHAT THIS PLATFORM ACTUALLY IS — read before extending this file:
 * Agentverse is NOT a task marketplace like moltMarket/openTask (browse
 * open paid tasks → bid → deliver). It is an agent DIRECTORY + identity
 * registry: agents register a real cryptographic address, other agents
 * and ASI:One (Fetch.ai's LLM) discover them by search, and requests are
 * routed to whatever `url` the agent registered. There is no "reward"
 * field anywhere in this API — see docs.agentverse.ai. Do NOT wire this
 * into MarketplacePipeline/STRATEGIES; it has no discover→bid→submit
 * shape to fit. What it DOES give this project: visibility (other agents
 * and ASI:One can find and call us) and, by registering `agent_type:
 * "a2a"` with `url` pointing at our own a2aServer.js's public endpoint,
 * a second real inbound channel for the A2A server we already run — no
 * new protocol to implement on the receiving side.
 *
 * IDENTITY: Agentverse requires a real bech32 "agent1..." address, which
 * must come from Fetch.ai's own key-derivation scheme. This connector
 * does NOT reimplement that in JS (see python_bridge/agentverse_bridge.py
 * for why) — it shells out to the official `uagents-core` Python package
 * for that one step, exactly like connectors/agentBazaar.js does for
 * AgentBazaar's Python-only SDK.
 *
 * VERIFIED FROM docs.agentverse.ai (fetched directly, not guessed):
 *   - POST https://agentverse.ai/v2/agents   — register/update a listing
 *       body: { address, name, url?, agent_type?, profile?, endpoints?,
 *               protocols?, metadata? } -> { success: boolean }
 *       "Registrations via the v2 API are permanent — no need for
 *       periodic refresh" (uagents-core README). Register once.
 *   - POST https://agentverse.ai/v1/search   — discover other agents
 *       body: { filters: { state, category, agent_type, protocol_digest },
 *               sort, direction, search_text, offset, limit }
 *       -> [{ address, name, readme, status, total_interactions,
 *              recent_interactions, rating, type, category, ... }]
 * ASSUMED (not shown verbatim in either page, but the only credential
 * this connector has to offer, and the Search API's own example uses
 * exactly this scheme): both calls take `Authorization: Bearer
 * <AGENTVERSE_API_KEY>`. If Agentverse's real server disagrees, these
 * calls surface the exact HTTP status/body rather than pretending to
 * succeed — consistent with how moltbook.js/colony.js handle their own
 * unverified-until-tested edges.
 *
 * REQUIRES:
 *   - AGENTVERSE_API_KEY        (you have this already)
 *   - AGENTVERSE_AGENT_SEED     (NEW — not in your original 36-variable
 *     list. A private seed phrase YOU choose and keep secret; it
 *     deterministically derives your agent's address. Losing/rotating it
 *     changes your address, which Agentverse then treats as a brand new
 *     agent with no history.)
 *   - python3 on PATH + `pip install uagents-core` (address derivation only)
 *   - A2A_SERVER_PUBLIC_URL (already used elsewhere in this project) as
 *     the default `url` to register — reuses the A2A server we already run.
 */

const BRIDGE_SCRIPT = path.join(__dirname, "python_bridge", "agentverse_bridge.py");
const AGENTVERSE_API_BASE = "https://agentverse.ai";

function runBridge(command, args = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [BRIDGE_SCRIPT, command, JSON.stringify(args)]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    proc.on("error", (err) => {
      reject(new Error(`Failed to launch python3 bridge: ${err.message}`));
    });

    proc.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").pop());
        if (parsed.error) {
          reject(new Error(parsed.error));
        } else {
          resolve(parsed.result);
        }
      } catch (err) {
        reject(new Error(`Could not parse agentverse bridge output: ${stdout || stderr}`));
      }
    });
  });
}

class AgentverseConnector {
  constructor({ bridge } = {}) {
    this.name = "Agentverse";
    // Injectable for tests; defaults to the real python3 bridge.
    this._runBridge = bridge || runBridge;
    this._cachedAddress = null;
  }

  /**
   * Per-operation status, same pattern as agenc.js/agentBazaar.js:
   * `listAgents` (the Search API) only needs the API key. `register`
   * additionally needs the seed phrase, since it must produce a real
   * signed-for address. Called with no operation, falls back to
   * requiring both (a summary view showing the stricter picture).
   */
  status(operation) {
    const hasKey = Boolean(process.env.AGENTVERSE_API_KEY);
    const hasSeed = Boolean(process.env.AGENTVERSE_AGENT_SEED);
    if (operation === "listAgents") return hasKey ? "CONNECTED" : "CREDENTIAL_REQUIRED";
    if (operation === "register") return hasKey && hasSeed ? "CONNECTED" : "CREDENTIAL_REQUIRED";
    return hasKey && hasSeed ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  /** Deterministic from the seed — safe to derive once and reuse for the process lifetime. */
  async getAddress() {
    if (this._cachedAddress) return this._cachedAddress;
    const seed = process.env.AGENTVERSE_AGENT_SEED;
    if (!seed) throw new Error("AGENTVERSE_AGENT_SEED is not set.");
    const { address } = await this._runBridge("address", { seed });
    this._cachedAddress = address;
    return address;
  }

  /**
   * Register (or update — same endpoint) this agent's Agentverse listing.
   * Defaults `url` to A2A_SERVER_PUBLIC_URL and `agent_type` to "a2a" so
   * Agentverse/ASI:One route requests straight to the A2A server this
   * project already runs (src/a2aServer.js) — no separate inbound
   * channel to build or maintain.
   */
  async register({ name, url, agentType = "a2a", profile, metadata } = {}) {
    if (this.status("register") !== "CONNECTED") {
      throw new Error("Agentverse register() requires AGENTVERSE_API_KEY and AGENTVERSE_AGENT_SEED.");
    }
    const address = await this.getAddress();
    const resolvedUrl = url || process.env.A2A_SERVER_PUBLIC_URL;
    if (!resolvedUrl) {
      throw new Error(
        "No url to register: pass one explicitly or set A2A_SERVER_PUBLIC_URL (this project's A2A server public address)."
      );
    }
    const body = {
      address,
      name: (name || process.env.AGENTVERSE_AGENT_NAME || "Universal Digital Agent").slice(0, 32),
      url: resolvedUrl,
      agent_type: agentType,
      ...(profile ? { profile } : {}),
      ...(metadata ? { metadata } : {}),
    };

    const res = await fetch(`${AGENTVERSE_API_BASE}/v2/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AGENTVERSE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Agentverse register failed: ${res.status} ${res.statusText} — ${text}`);
    }
    const json = await res.json().catch(() => ({}));
    return { address, url: resolvedUrl, ...json };
  }

  /**
   * Discover other agents via Agentverse's real Search API
   * (POST /v1/search — see docs.agentverse.ai / innovationlab.fetch.ai).
   * Read-only, no signing, no address needed — just the API key.
   */
  async listAgents({ searchText = "", limit = 20, offset = 0, agentType = [], category = [], state = [] } = {}) {
    if (this.status("listAgents") !== "CONNECTED") {
      throw new Error("Agentverse listAgents() requires AGENTVERSE_API_KEY.");
    }
    const res = await fetch(`${AGENTVERSE_API_BASE}/v1/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AGENTVERSE_API_KEY}`,
      },
      body: JSON.stringify({
        filters: { state, category, agent_type: agentType, protocol_digest: [] },
        sort: "relevancy",
        direction: "asc",
        search_text: searchText,
        offset,
        limit,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Agentverse listAgents failed: ${res.status} ${res.statusText} — ${text}`);
    }
    return res.json();
  }
}

module.exports = AgentverseConnector;
