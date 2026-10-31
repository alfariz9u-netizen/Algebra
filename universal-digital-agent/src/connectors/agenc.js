"use strict";

/**
 * Real adapter for AgenC (https://agenc.ag) — a live protocol on Solana
 * mainnet. Tasks are posted with SOL escrowed on-chain; agents register
 * on-chain and get paid from escrow on acceptance.
 *
 * Docs used to build this: https://agenc.ag/docs/quickstart-workers,
 * the SDK README (github.com/tetsuo-ai/agenc-protocol, packages/sdk-ts) and the
 * read API's OpenAPI spec (https://agenc.ag/openapi.json).
 * Package: @tetsuo-ai/marketplace-sdk (npm), @solana/kit (npm)
 *
 * REQUIRES (not simulated — you must supply these to actually run it):
 *   - npm install @tetsuo-ai/marketplace-sdk @solana/kit
 *   - AGENC_RPC_URL          e.g. https://api.mainnet-beta.solana.com
 *   - AGENC_WALLET_PATH      path to a solana-keygen JSON keypair file,
 *                            funded with ~0.03-0.05 SOL (see docs/setup.md)
 *   - AGENC_AGENT_ID         the 32-byte agentId (64 hex chars) this worker was
 *                            registered on-chain with; its agent PDA is derived
 *                            from it and is required by claim/submit
 *   - AGENC_CAPABILITIES     bitmask (bigint string) this worker claims to have,
 *                            defaults to "1" (COMPUTE); tasks that require other
 *                            bits are not offered (the claim would fail on-chain)
 *
 * Discovery (fetchIncomingTasks) is read-only against the public REST API
 * and needs no wallet. Only submitDeliverable needs a funded signer.
 *
 * READ API SHAPE (OpenAPI): GET /api/tasks?status=open&pageSize=N answers
 * { items: TaskView[], page, pageSize, total }. A TaskView is identified by its
 * `pda` (there is no `taskId`), prices the reward in `rewardLamports` (a decimal
 * STRING; `rewardMint` is null for SOL), carries `deadlineUnix` (seconds),
 * `title`, `requiredCapabilities`, `minReputation`, `jobSpecUri`, `jobSpecHash`
 * and `taskType` ("exclusive" | "collaborative" | ...) — an on-chain mode, NOT a
 * business type.
 */

const crypto = require("node:crypto");
const { assertSafeUrl } = require("../core/ssrfGuard");

const READ_API_BASE = process.env.AGENC_READ_API_BASE || "https://api.agenc.ag/api";

const positiveInt = (raw, fallback) => (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Math.floor(Number(raw)) : fallback);
const PAGE_SIZE = () => positiveInt(process.env.AGENC_PAGE_SIZE, 50);
const FETCH_TIMEOUT_MS = () => positiveInt(process.env.AGENC_FETCH_TIMEOUT_MS, 15000);
const SPEC_MAX_BYTES = () => positiveInt(process.env.AGENC_SPEC_MAX_BYTES, 64 * 1024);
// Time we need between discovery and the on-chain submit (LLM work + QA + approval).
const MIN_TIME_LEFT_MS = () => positiveInt(process.env.AGENC_MIN_TIME_LEFT_MS, 30 * 60 * 1000);
const MAX_REDIRECTS = 3;

function toBigInt(v) {
  try {
    return BigInt(String(v).trim());
  } catch {
    return null;
  }
}

/** This worker's capability bitmask (AGENC_CAPABILITIES, default COMPUTE = 1). */
function workerCapabilities() {
  const parsed = toBigInt(process.env.AGENC_CAPABILITIES || "1");
  return parsed === null || parsed < 0n ? 1n : parsed;
}

function hexToBytes(hex, length) {
  const clean = String(hex || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(clean) || (length && clean.length !== length * 2)) return null;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

/** Does sha256(bytes) equal the on-chain jobSpecHash? true/false when the encoding is recognized, null when it isn't. */
function matchesJobSpecHash(bytes, jobSpecHash) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const want = String(jobSpecHash || "").trim().replace(/^(sha256:|0x)/i, "");
  if (/^[0-9a-f]{64}$/i.test(want)) return digest.toString("hex") === want.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=?$/.test(want)) return digest.toString("base64").replace(/=$/, "") === want.replace(/=$/, "");
  return null;
}

/**
 * Maps one TaskView (tolerating the pre-OpenAPI field names the old code assumed)
 * onto this platform's internal task shape. Returns null for a record with no id.
 */
function mapTaskView(t) {
  const id = t && (t.pda || t.taskId || t.id);
  if (!id) return null;
  const title = typeof t.title === "string" ? t.title.trim() : "";
  return {
    id,
    // The business type used for capability routing. (`taskType` on the wire is the
    // on-chain mode — exclusive/competitive/... — and must not be used for routing.)
    type: "business_automation",
    clientLocale: "en-US",
    input: {
      spec: title || t.jobSpecUri || t.specUri || null,
      title: title || null,
      rewardLamports: t.rewardLamports ?? t.reward ?? null,
      rewardMint: t.rewardMint ?? null,
      deadline: t.deadlineUnix ?? t.deadline ?? null,
      jobSpecUri: t.jobSpecUri || t.specUri || null,
      jobSpecHash: t.jobSpecHash || null,
      requiredCapabilities: t.requiredCapabilities ?? null,
      minReputation: t.minReputation ?? null,
      onChainTaskType: t.taskType || null,
    },
    _marketplaceRaw: t,
  };
}

/** Is this open task one we can actually claim and finish? */
function isClaimable(t, now) {
  if (t.status && t.status !== "open") return false;
  if (!t.jobSpecHash) return false; // claim_task_with_job_spec needs the hash; the bare claim_task fails closed on-chain
  const deadlineMs = Number(t.deadlineUnix ?? t.deadline ?? 0) * 1000;
  if (deadlineMs > 0 && deadlineMs - now < MIN_TIME_LEFT_MS()) return false;
  const required = toBigInt(t.requiredCapabilities ?? 0);
  if (required !== null && (required & workerCapabilities()) !== required) return false;
  return true;
}

/**
 * Fetches a job spec the (untrusted) task creator pointed at. Only https, SSRF-guarded on every
 * redirect hop, size- and time-capped, and checked against the on-chain hash.
 * Returns { text, verified } or null when it can't be resolved (e.g. an agenc:// URI).
 */
async function fetchJobSpec(uri, jobSpecHash) {
  if (!uri || !/^https:\/\//i.test(String(uri))) return null;
  const limit = SPEC_MAX_BYTES();
  let url = String(uri);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS()) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`job spec fetch failed: ${res.status}`);
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`job spec larger than ${limit} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(0)) throw new Error("job spec is binary, not text");
    const verified = matchesJobSpecHash(bytes, jobSpecHash);
    if (verified === false) throw new Error("job spec does not match the on-chain jobSpecHash");
    return { text: bytes.toString("utf8"), verified };
  }
  throw new Error("job spec: too many redirects");
}

class AgencAdapter {
  constructor() {
    this.name = "AgenC";
    this._client = null; // lazily created, only if a wallet is configured
    this._workerPda = null;
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
   * actually broken.
   */
  status(operation) {
    if (operation === "fetchIncomingTasks") return "CONNECTED";
    return process.env.AGENC_WALLET_PATH && process.env.AGENC_RPC_URL ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  /**
   * Read-only discovery over AgenC's public, keyless REST API.
   * GET https://api.agenc.ag/api/tasks?status=open&pageSize=N
   * Only tasks this worker can really claim and finish are returned.
   */
  async fetchIncomingTasks({ now = Date.now() } = {}) {
    const url = `${READ_API_BASE}/tasks?status=open&pageSize=${PAGE_SIZE()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS()) });
    if (!response.ok) {
      throw new Error(`AgenC read API request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    // The API has returned an array, {items} (the documented shape), {tasks} and {data}; an object
    // without a list (e.g. an error body) used to crash with "tasks.map is not
    // a function". Anything unrecognized now yields [] plus a warning.
    const rawTasks = Array.isArray(data) ? data
      : Array.isArray(data?.tasks) ? data.tasks
      : Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.data) ? data.data
      : [];
    if (rawTasks.length === 0 && data && typeof data === "object") {
      console.warn(`[agenc] unexpected response: ${Object.keys(data).join(",")}`);
    }

    // Map AgenC's on-chain task shape onto this platform's internal task shape.
    return rawTasks.filter((t) => t && isClaimable(t, now)).map(mapTaskView).filter(Boolean);
  }

  /** Resolves a task's job spec text (see fetchJobSpec). Never throws: null means "use the title only". */
  static async fetchJobSpec(uri, jobSpecHash) {
    try {
      return await fetchJobSpec(uri, jobSpecHash);
    } catch (err) {
      console.warn(`[agenc] could not use job spec ${uri}: ${err.message}`);
      return null;
    }
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
    const sdk = require("@tetsuo-ai/marketplace-sdk");
    const { readFileSync } = require("node:fs");

    const secretKey = new Uint8Array(JSON.parse(readFileSync(walletPath, "utf8")));
    const signer = await createKeyPairSignerFromBytes(secretKey);
    const client = sdk.createMarketplaceClient({ rpcUrl, signer });

    this._client = { client, signer, sdk };
    return this._client;
  }

  /** This worker's on-chain agent PDA, derived from AGENC_AGENT_ID (claim/submit both need it as `worker`). */
  async _getWorkerPda(sdk) {
    if (this._workerPda) return this._workerPda;
    const agentId = hexToBytes(process.env.AGENC_AGENT_ID, 32);
    if (!agentId) {
      throw new Error(
        "AgenC submission requires AGENC_AGENT_ID: the 32-byte agentId (64 hex chars) this worker was registered on-chain with."
      );
    }
    const [worker] = await sdk.findAgentPda({ agentId });
    this._workerPda = worker;
    return worker;
  }

  /** Is this task already claimed by our worker (e.g. an earlier run claimed it and then failed before submitting)? */
  async _isClaimedBy(taskPda, workerPda) {
    try {
      const res = await fetch(`${READ_API_BASE}/tasks/${encodeURIComponent(taskPda)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS()) });
      if (!res.ok) return false;
      const task = (await res.json())?.task || {};
      const mine = String(workerPda?.address ?? workerPda);
      return task.workerPda === mine || (task.workerPdas || []).includes(mine);
    } catch {
      return false;
    }
  }

  /**
   * Claims the on-chain task, then submits the deliverable's content hash.
   * Two real Solana transactions (claim_task_with_job_spec, submit_task_result) —
   * they cost real fees/rent and need the claim gates (registered agent,
   * reputation, capability match) already satisfied on-chain.
   *
   * @param {string} taskPda  the task's PDA (the `id` fetchIncomingTasks() returns)
   * @param {{ content: string, resultUri?: string|null, jobSpecHash?: string }} deliverable
   */
  async submitDeliverable(taskPda, deliverable) {
    const { client, signer, sdk } = await this._getClient();
    const worker = await this._getWorkerPda(sdk);

    // The proof is the sha256 of the delivered text itself, so the buyer can verify it.
    const content = String(deliverable?.content ?? "");
    if (!content.trim()) throw new Error("AgenC submitDeliverable: content is empty — nothing to prove.");
    const proofHash = new Uint8Array(crypto.createHash("sha256").update(content, "utf8").digest());

    // 1) Claim (bare claim_task is not exposed: the program fails closed on it).
    let claimSignature;
    const jobSpecHash = hexToBytes(deliverable.jobSpecHash, 32) || deliverable.jobSpecHash;
    if (!jobSpecHash) throw new Error(`AgenC task ${taskPda} has no jobSpecHash — it cannot be claimed.`);
    try {
      const claim = await client.claimTaskWithJobSpec({ task: taskPda, worker, authority: signer, jobSpecHash });
      claimSignature = claim?.signature;
    } catch (err) {
      if (!(await this._isClaimedBy(taskPda, worker))) throw err;
      console.warn(`[agenc] task ${taskPda} is already claimed by this worker — submitting the result.`);
    }

    // 2) Submit the proof. Only the hash goes on-chain; `resultData` can point at where the content lives.
    const result = await client.submitTaskResult({
      task: taskPda,
      worker,
      authority: signer,
      proofHash,
      resultData: deliverable.resultUri || null,
    });

    return {
      accepted: true,
      taskId: taskPda,
      txSignature: result?.signature,
      claimSignature,
      contentPublished: Boolean(deliverable.resultUri),
    };
  }
}

module.exports = AgencAdapter;
module.exports.mapTaskView = mapTaskView;
module.exports.isClaimable = isClaimable;
module.exports.matchesJobSpecHash = matchesJobSpecHash;
