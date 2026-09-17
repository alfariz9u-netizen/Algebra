"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

/**
 * Real adapter for AgentBazaar (Solana-based AI agent marketplace).
 * AgentBazaar only publishes an official Python SDK (`pip install
 * agentsbazaar`) — there is no first-party JS/TS SDK — so this adapter
 * shells out to a small bridge script rather than guessing at an
 * unofficial REST contract.
 *
 * REQUIRES:
 *   - python3 on PATH
 *   - pip install agentsbazaar
 *   - A funded Solana keypair for hiring (list_agents/stats work read-only,
 *     no wallet needed) — see docs/setup.md
 */

const BRIDGE_SCRIPT = path.join(__dirname, "python_bridge", "agentbazaar_bridge.py");

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
        reject(new Error(`Could not parse agentbazaar bridge output: ${stdout || stderr}`));
      }
    });
  });
}

class AgentBazaarAdapter {
  constructor() {
    this.name = "AgentBazaar";
  }

  status() {
    // list_agents/stats work with no wallet; hiring needs a funded Solana keypair.
    return "CREDENTIAL_REQUIRED";
  }

  /**
   * Read-only discovery: lists agents currently offering services on
   * AgentBazaar. No wallet required.
   */
  async fetchIncomingTasks() {
    const result = await runBridge("list_agents");
    const agents = result?.agents || [];

    // AgentBazaar's model is "hire an agent for a task" rather than a task
    // board of open jobs, so we surface listed agents as hire opportunities
    // the platform's own agents could fulfil on the client's behalf.
    return agents.map((listedAgent) => ({
      id: listedAgent.id || listedAgent.name,
      type: "business_automation",
      clientLocale: "en-US",
      input: {
        process: `Evaluate/fulfil AgentBazaar listing: ${listedAgent.name}`,
        systems: ["AgentBazaar"],
      },
      _marketplaceRaw: listedAgent,
    }));
  }

  /**
   * Hires an agent on AgentBazaar to actually perform a task — a real,
   * paid, on-chain-settled call via the official SDK. Requires a funded
   * Solana keypair (SOLANA_PRIVATE_KEY env var or ~/.config/solana/id.json).
   */
  async submitDeliverable(taskId, deliverable) {
    const task = deliverable.taskDescription || `Task ${taskId}`;
    const skills = deliverable.skills || "general";
    const result = await runBridge("call", { task, skills });
    return { accepted: true, taskId, result };
  }

  async stats() {
    return runBridge("stats");
  }
}

module.exports = AgentBazaarAdapter;
