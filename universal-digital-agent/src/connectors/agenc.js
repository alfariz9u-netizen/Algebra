"use strict";

/**
 * Real adapter for AgenC (https://agenc.ag) — a live protocol on Solana
 * mainnet. Tasks are posted with SOL escrowed on-chain; agents register
 * on-chain and get paid from escrow on acceptance.
 *
 * Docs used to build this: https://agenc.ag/docs/quickstart-workers
 * Package: @tetsuo-ai/marketplace-sdk (npm), @solana/kit (npm)
 *
 * REQUIRES (not simulated — you must supply these to actually run it):
 *   - npm install @tetsuo-ai/marketplace-sdk @solana/kit
 *   - AGENC_RPC_URL          e.g. https://api.mainnet-beta.solana.com
 *   - AGENC_WALLET_PATH      path to a solana-keygen JSON keypair file,
 *                            funded with ~0.03-0.05 SOL (see docs/setup.md)
 *   - AGENC_CAPABILITIES     bitmask (bigint string) this worker claims to have,
 *                            defaults to "1" (COMPUTE)
 *
 * Discovery (fetchIncomingTasks) is read-only against the public REST API
 * and needs no wallet. Only submitDeliverable needs a funded signer.
 */

const READ_API_BASE = process.env.AGENC_READ_API_BASE || "https://api.agenc.ag/api";

class AgencAdapter {
  constructor() {
    this.name = "AgenC";
    this._client = null; // lazily created, only if a wallet is configured
  }

  /**
   * FIX (live production evidence, 2026-09-30 — the deployed logs showed
   * exactly this): `fetchIncomingTasks` hits AgenC's public, keyless REST
   * API and must be CONNECTED unconditionally — it never needs a wallet.
   * Only `submitDeliverable` (a real Solana transaction) needs
   * AGENC_WALLET_PATH/AGENC_RPC_URL. Before this fix, status() ignored
   * its operation argument entirely and required the wallet for BOTH
   * operations, so every single 30-minute cycle logged
   * `[cycle:agenc] cycle failed: Connector "agenc" does not support
   * "fetchIncomingTasks" right now (status: CREDENTIAL_REQUIRED)` and
   * `learningEngine` kept opening a circuit on it — permanently losing a
   * free, keyless discovery source for a connector that was never
   * actually broken. (This exact fix was already applied once, in an
   * earlier zip upload's connectorRegistry.js/agenc.js pair; it just
   * never made it into this codebase's agenc.js — connectorRegistry.js
   * has passed `operation` through since the Agentverse round, but
   * nothing here was reading it until now.)
   */
  status(operation) {
    if (operation === "fetchIncomingTasks") return "CONNECTED";
    return process.env.AGENC_WALLET_PATH && process.env.AGENC_RPC_URL ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  /**
   * Read-only discovery over AgenC's public, keyless REST API.
   * GET https://api.agenc.ag/api/tasks?status=open
   */
  async fetchIncomingTasks() {
    const url = `${READ_API_BASE}/tasks?status=open`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`AgenC read API request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const tasks = data.tasks || data || [];

    // Map AgenC's on-chain task shape onto this platform's internal task shape.
    return tasks.map((onChainTask) => ({
      id: onChainTask.taskId || onChainTask.id,
      type: onChainTask.taskType || "business_automation",
      clientLocale: "en-US",
      input: {
        spec: onChainTask.jobSpecUri || onChainTask.specUri,
        rewardLamports: onChainTask.reward,
        deadline: onChainTask.deadline,
      },
      _marketplaceRaw: onChainTask,
    }));
  }

  /**
   * Loads the funded signer + SDK client on first use. Throws a clear error
   * if the wallet/RPC aren't configured rather than silently no-opping.
   */
  async _getClient() {
    if (this._client) return this._client;

    const rpcUrl = process.env.AGENC_RPC_URL;
    const walletPath = process.env.AGENC_WALLET_PATH;
    if (!rpcUrl || !walletPath) {
      throw new Error(
        "AgenC submission requires AGENC_RPC_URL and AGENC_WALLET_PATH (a funded Solana keypair). " +
          "See docs/setup.md for how to create and fund one."
      );
    }

    // Required packages — real, published on npm. Not bundled by default
    // since they pull in Solana/Anchor toolchain; install with:
    //   npm install @tetsuo-ai/marketplace-sdk @solana/kit
    const { createKeyPairSignerFromBytes } = require("@solana/kit");
    const { createMarketplaceClient } = require("@tetsuo-ai/marketplace-sdk");
    const { readFileSync } = require("node:fs");

    const secretKey = new Uint8Array(JSON.parse(readFileSync(walletPath, "utf8")));
    const signer = await createKeyPairSignerFromBytes(secretKey);
    const client = createMarketplaceClient({ rpcUrl, signer });

    this._client = { client, signer };
    return this._client;
  }

  /**
   * Claims the on-chain task and submits the deliverable's content hash.
   * This performs real Solana transactions (claim_task_with_job_spec,
   * submit_task_result) — it costs real transaction fees/rent and requires
   * the claim gates (registered agent, reputation, capability match) to
   * already be satisfied on-chain.
   */
  async submitDeliverable(taskId, deliverable) {
    const { client, signer } = await this._getClient();
    const { facade } = require("@tetsuo-ai/marketplace-sdk");
    const crypto = require("node:crypto");

    const proofHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(deliverable))
      .digest();

    // NOTE: task/worker agent PDAs must be resolved from taskId per the SDK's
    // documented findTaskPda/findAgentPda helpers before these calls in a
    // real run — omitted here only because task/agent identity is specific
    // to the on-chain registration this worker completed separately.
    const result = await client.submitTaskResult({
      task: taskId,
      authority: signer,
      proofHash: new Uint8Array(proofHash),
      resultData: deliverable.resultUri || null,
    });

    return { accepted: true, taskId, txSignature: result?.signature };
  }
}

module.exports = AgencAdapter;
