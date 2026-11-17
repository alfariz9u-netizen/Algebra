"use strict";

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");
const { SupabaseState, WriteBehindQueue, eq, isRetryable } = require("./persistence/supabaseState");

/**
 * Turns `pending_human_approval` from a dead-end JSON blob into something a
 * human can actually act on: list what's waiting, approve or deny it, and
 * — for task-level approvals — resume the exact original task afterward.
 *
 * LIFECYCLE (added — this is the real fix for two concrete bugs):
 *   pending → approved | denied        (unchanged: a human's decision)
 *   approved → claimed → executing → consumed | failed
 *
 * WHY "claimed" EXISTS: `resumeTask()` used to just check
 * `record.status === "approved"` and go — with NO step that marked the
 * approval as "being executed". Two near-simultaneous resume attempts for
 * the SAME approvalId (a double-tap on a Telegram button, a retried HTTP
 * request, a human running `approvalCli.js resume` while the Telegram bot
 * is also processing it) would BOTH see "approved" and BOTH execute —
 * approval replay, exactly what was asked to be prevented. `claim()` is a
 * compare-and-swap: only the FIRST caller to claim an "approved" record
 * succeeds; every other concurrent caller gets a clear conflict error
 * instead of silently re-running the task.
 *
 * WHY EVERY MUTATING METHOD RE-READS FROM DISK FIRST: `this.records` used
 * to be loaded once, in the constructor, and only ever written back
 * (never refreshed). JsonFileStore.save() is atomic at the file level
 * (write-temp-then-rename — see fileStore.js), but that alone doesn't
 * prevent a LOST UPDATE across processes: if combinedServer.js's
 * long-running process and a separate `node approvalCli.js approve <id>`
 * invocation are both alive, the long-running process's in-memory
 * `this.records` goes stale the moment the CLI writes — and the next
 * time the long-running process persists ANYTHING, it silently overwrites
 * the CLI's change with its stale copy. Every mutating method here now
 * reloads fresh from disk immediately before mutating, and every
 * transition is a version-checked compare-and-swap (optimistic
 * concurrency): the caller must supply the version it last saw, and the
 * write is rejected — not silently applied — if that's gone stale.
 *
 * PERSISTENCE MATTERS HERE MORE THAN ANYWHERE ELSE: the process that
 * discovered the task and the human (or CLI) approving it are almost
 * always different processes. Without `persistDir`, approvals only exist
 * in the memory of whichever process created them.
 */

const TERMINAL_STATUSES = new Set(["denied", "consumed", "failed"]);

// FIX (stuck approvals): if the process executing a claimed approval
// crashes (or is killed, or hangs) between markExecuting() and
// consume()/fail(), the record is stuck in "executing" forever — nothing
// else can ever claim it again (claim() only accepts "approved"), so it
// silently blocks that task's approvalId permanently with no error
// anywhere. 10 minutes is far longer than any real task in this project
// takes (LLM calls + one HTTP submission), so anything still "executing"
// past that is a crashed/hung process, not a slow one. Overridable via
// APPROVAL_EXECUTING_TIMEOUT_MS for environments with genuinely
// longer-running tasks.
const EXECUTING_TIMEOUT_MS = Number(process.env.APPROVAL_EXECUTING_TIMEOUT_MS || 10 * 60 * 1000);

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

// ---- Supabase mapping (table `approvals`, see supabase/migrations/001_state_tables.sql) ----
const FIELD_TO_COLUMN = {
  taskId: "task_id",
  task: "task",
  capability: "capability",
  connector: "connector",
  action: "action",
  riskLevel: "risk_level",
  status: "status",
  version: "version",
  requestedAt: "requested_at",
  resolvedAt: "resolved_at",
  resolvedBy: "resolved_by",
  claimedAt: "claimed_at",
  claimedBy: "claimed_by",
  executingAt: "executing_at",
  consumedAt: "consumed_at",
  result: "result",
};
const TIMESTAMP_FIELDS = new Set(["requestedAt", "resolvedAt", "claimedAt", "executingAt", "consumedAt"]);

function recordToRow(r) {
  const row = { id: r.id };
  for (const [field, col] of Object.entries(FIELD_TO_COLUMN)) row[col] = r[field] === undefined ? null : r[field];
  return row;
}

function rowToRecord(row) {
  const r = { id: row.id };
  for (const [field, col] of Object.entries(FIELD_TO_COLUMN)) {
    const v = row[col] === undefined ? null : row[col];
    r[field] = TIMESTAMP_FIELDS.has(field) && v ? new Date(v).toISOString() : v;
  }
  r.version = Number(r.version) || 1;
  r.resumable = Boolean(r.task); // not a column: derived exactly like enqueue() does
  return r;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

class ApprovalQueue {
  /**
   * STORAGE: records live in memory and in `persistDir/approvals.json` (the
   * fallback), exactly as before. When SUPABASE_URL/SUPABASE_SERVICE_KEY are
   * set they are also replicated to the `approvals` table, and `await init()`
   * loads them back after a redeploy wipes the disk. Every replicated
   * transition is `UPDATE ... WHERE id = X AND version = <previous>`, so two
   * processes can never both win the same transition. For the one step where
   * a lost race means a double execution — claim() — use `await claimRemote()`,
   * which does that compare-and-swap against Supabase BEFORE any work starts.
   */
  constructor({ persistDir, encryptionKey, supabase } = {}) {
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "approvals.json"), { encryptionKey }) : null;
    this.records = this._store ? this._store.load([]) : [];
    this._remote = supabase || new SupabaseState();
    this._remoteEnabled = this._remote.enabled;
    this._queue = new WriteBehindQueue({ label: "approvals", reconcile: () => this._syncWithRemote() });
    const ttl = Number(process.env.APPROVAL_REFRESH_TTL_MS ?? 5000);
    this._refreshTtlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 5000;
    this._lastRemotePull = 0;
    this._initPromise = null;
  }

  /** Loads Supabase's approvals into memory (merge: higher version wins). Never rejects. */
  init() {
    if (!this._remoteEnabled) return Promise.resolve();
    if (!this._initPromise) {
      this._initPromise = this._queue.push(() => this._syncWithRemote()).then(() => undefined);
    }
    return this._initPromise;
  }

  flush() {
    return this._queue.flush();
  }

  /** Pulls the latest approvals from Supabase now (e.g. one created or approved by another process). */
  async refresh() {
    if (!this._remoteEnabled) return;
    await this._queue.push(() => this._syncWithRemote());
  }

  async _syncWithRemote() {
    const remoteRows = await this._remote.selectAll("approvals", "select=*");
    const remote = new Map(remoteRows.map((row) => [row.id, rowToRecord(row)]));
    const byId = new Map(this.records.map((r) => [r.id, r]));
    const toPush = [];
    for (const [id, rec] of remote) {
      const local = byId.get(id);
      if (!local || rec.version > local.version) byId.set(id, rec);
      else if (local.version > rec.version) toPush.push(local);
    }
    for (const [id, local] of byId) if (!remote.has(id)) toPush.push(local);
    this.records = [...byId.values()].sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    this._persist();
    this._lastRemotePull = Date.now();
    if (toPush.length) await this._remote.upsert("approvals", toPush.map(recordToRow), { onConflict: "id", mode: "merge" });
  }

  /** Throttled background pull so a long-running process sees approvals made elsewhere (e.g. the CLI). */
  _maybeRefreshRemote() {
    if (!this._remoteEnabled || Date.now() - this._lastRemotePull < this._refreshTtlMs) return;
    this._lastRemotePull = Date.now();
    this._queue.push(() => this._syncWithRemote());
  }

  _adopt(record) {
    const i = this.records.findIndex((r) => r.id === record.id);
    if (i === -1) this.records.push(record);
    else this.records[i] = record;
    this._persist();
  }

  _mirrorUpsert(record) {
    if (!this._remoteEnabled) return;
    const row = recordToRow(clone(record));
    this._queue.push(() => this._remote.upsert("approvals", [row], { onConflict: "id", mode: "merge" }));
  }

  /** Optimistic concurrency: only replaces the row if it is still at `prevVersion`. */
  _mirrorTransition(record, prevVersion) {
    if (!this._remoteEnabled) return;
    const snapshot = clone(record);
    this._queue.push(async () => {
      const row = recordToRow(snapshot);
      const updated = await this._remote.patch("approvals", `${eq("id", snapshot.id)}&version=eq.${prevVersion}`, row);
      if (updated.length > 0) return;
      const current = await this._remote.request("GET", `approvals?${eq("id", snapshot.id)}&select=*`);
      if (!Array.isArray(current) || current.length === 0) {
        await this._remote.upsert("approvals", [row], { onConflict: "id", mode: "merge" }); // never reached Supabase (earlier outage)
        return;
      }
      const remote = rowToRecord(current[0]);
      if (remote.version >= snapshot.version) {
        console.warn(`[approvals] ${snapshot.id}: Supabase is already at version ${remote.version} (${remote.status}) — another process acted first; adopting its state.`);
        this._adopt(remote);
      } else {
        await this._remote.upsert("approvals", [row], { onConflict: "id", mode: "merge" }); // remote missed intermediate steps
      }
    });
  }

  // Always the current on-disk truth (a no-op, returning the in-memory
  // array, when there's no persistDir — single-process-only mode).
  // Also reaps any approval stuck in "executing" past the timeout (see
  // EXECUTING_TIMEOUT_MS above) — called from every read/write path
  // (list(), get(), and every _transition()), so a stuck record is
  // caught and failed wherever it's next touched, not just on a
  // dedicated sweep.
  _reload() {
    if (this._store) this.records = this._store.load([]);
    this._reapStuckExecuting();
    this._maybeRefreshRemote();
    return this.records;
  }

  _reapStuckExecuting() {
    const now = Date.now();
    let changed = false;
    for (const record of this.records) {
      if (record.status !== "executing" || !record.executingAt) continue;
      const elapsed = now - new Date(record.executingAt).getTime();
      if (elapsed > EXECUTING_TIMEOUT_MS) {
        record.status = "failed";
        record.version += 1;
        this._reapedForMirror = (this._reapedForMirror || []).concat(record);
        record.result = {
          error: `Execution timed out after ${Math.round(elapsed / 1000)}s (stuck in "executing" since ${record.executingAt} — the process handling it likely crashed or hung before calling consume()/fail()).`,
        };
        changed = true;
      }
    }
    if (changed) {
      this._persist();
      // Each reaped record moved version N -> N+1; if another process reaped it first, the
      // version predicate makes this a no-op that adopts theirs instead of double-writing.
      for (const record of this._reapedForMirror || []) this._mirrorTransition(record, record.version - 1);
      this._reapedForMirror = [];
    }
  }

  _persist() {
    if (this._store) this._store.save(this.records);
  }

  /**
   * @param {{ taskId: string, task?: object, capability?: string, connector?: string, action: string, riskLevel: string }} params
   */
  enqueue({ taskId, task, capability, connector, action, riskLevel }) {
    this._reload();
    const id = `approval-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      taskId,
      task: task || null,
      capability: capability || null,
      connector: connector || null,
      action,
      riskLevel,
      resumable: Boolean(task),
      status: "pending",
      version: 1,
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      claimedAt: null,
      claimedBy: null,
      executingAt: null,
      consumedAt: null,
      result: null,
    };
    this.records.push(record);
    this._persist();
    this._mirrorUpsert(record);
    return record;
  }

  list({ status } = {}) {
    this._reload();
    return status ? this.records.filter((r) => r.status === status) : [...this.records];
  }

  get(id) {
    this._reload();
    return this.records.find((r) => r.id === id);
  }

  /** Internal: fresh-load, find by id, and assert it's in exactly the expected state before a transition. */
  _transition(id, { fromStatus, expectedVersion, mutate }) {
    this._reload();
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error(`No approval request with id "${id}".`);
    if (TERMINAL_STATUSES.has(record.status) && record.status !== fromStatus) {
      throw new ConflictError(`Approval "${id}" is already "${record.status}" (terminal) — cannot transition it.`);
    }
    if (record.status !== fromStatus) {
      throw new ConflictError(`Approval "${id}" is "${record.status}", expected "${fromStatus}" — someone else already acted on it.`);
    }
    if (expectedVersion !== undefined && record.version !== expectedVersion) {
      throw new ConflictError(
        `Approval "${id}" was modified concurrently (expected version ${expectedVersion}, found ${record.version}) — refusing to overwrite.`
      );
    }
    const prevVersion = record.version;
    mutate(record);
    record.version += 1;
    this._persist();
    this._mirrorTransition(record, prevVersion);
    return record;
  }

  /** The human's decision. Still a single terminal-or-not step, unchanged from before. */
  resolve(id, status, resolvedBy) {
    if (!["approved", "denied"].includes(status)) {
      throw new Error(`Invalid resolution status "${status}" — must be "approved" or "denied".`);
    }
    return this._transition(id, {
      fromStatus: "pending",
      mutate: (record) => {
        record.status = status;
        record.resolvedAt = new Date().toISOString();
        record.resolvedBy = resolvedBy || null;
      },
    });
  }

  /**
   * Atomic claim: the first caller to reach this for an "approved" record
   * wins; every subsequent concurrent caller gets a ConflictError. This is
   * the actual replay/race fix — call this BEFORE doing any real work,
   * and only proceed if it doesn't throw.
   */
  claim(id, claimedBy) {
    return this._transition(id, {
      fromStatus: "approved",
      mutate: (record) => {
        record.status = "claimed";
        record.claimedAt = new Date().toISOString();
        record.claimedBy = claimedBy || null;
      },
    });
  }

  /**
   * claim() with a real cross-process compare-and-swap. Prefer this in async
   * code (universalAgent.resumeTask does): the atomic step happens in Supabase
   * — `UPDATE approvals SET status='claimed', version=v+1 WHERE id=X AND
   * status='approved' AND version=v` — so if the CLI, the Telegram bot and the
   * agent all try at once, exactly one gets a row back and the rest get a
   * ConflictError, BEFORE any work runs.
   * Falls back to the local claim() when Supabase is not configured or
   * unreachable (replay protection is then per-machine, and a warning says so).
   */
  async claimRemote(id, claimedBy) {
    if (!this._remoteEnabled) return this.claim(id, claimedBy);
    try {
      await this._queue.flush(); // our own earlier writes (e.g. the approve) must be in Supabase first
      const rows = await this._remote.request("GET", `approvals?${eq("id", id)}&select=*`);
      if (!Array.isArray(rows) || rows.length === 0) {
        console.warn(`[approvals] ${id} not found in Supabase — claiming from the local copy only.`);
        return this.claim(id, claimedBy);
      }
      const current = rowToRecord(rows[0]);
      if (current.status !== "approved") {
        this._adopt(current);
        const terminal = TERMINAL_STATUSES.has(current.status);
        throw new ConflictError(
          terminal
            ? `Approval "${id}" is already "${current.status}" (terminal) — cannot transition it.`
            : `Approval "${id}" is "${current.status}", expected "approved" — someone else already acted on it.`
        );
      }
      const claimedAt = new Date().toISOString();
      const updated = await this._remote.patch("approvals", `${eq("id", id)}&status=eq.approved&version=eq.${current.version}`, {
        status: "claimed",
        claimed_at: claimedAt,
        claimed_by: claimedBy || null,
        version: current.version + 1,
      });
      if (updated.length === 0) {
        throw new ConflictError(`Approval "${id}" was modified concurrently (expected version ${current.version}) — refusing to overwrite.`);
      }
      const record = rowToRecord(updated[0]);
      this._adopt(record);
      return record;
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      if (!isRetryable(err) && err.name !== "SupabaseRequestError") throw err;
      console.warn(`[approvals] Supabase unavailable for claim of ${id} (${err.message}) — using the local copy; replay protection is per-machine until it recovers.`);
      return this.claim(id, claimedBy);
    }
  }

  markExecuting(id, expectedVersion) {
    return this._transition(id, {
      fromStatus: "claimed",
      expectedVersion,
      mutate: (record) => {
        record.status = "executing";
        record.executingAt = new Date().toISOString();
      },
    });
  }

  /** Terminal success. Once consumed, this approvalId can never be acted on again. */
  consume(id, expectedVersion, result) {
    return this._transition(id, {
      fromStatus: "executing",
      expectedVersion,
      mutate: (record) => {
        record.status = "consumed";
        record.consumedAt = new Date().toISOString();
        record.result = result === undefined ? null : result;
      },
    });
  }

  /** Terminal failure. Distinct from "consumed" so the audit trail shows the execution didn't actually finish. */
  fail(id, expectedVersion, reason) {
    return this._transition(id, {
      fromStatus: "executing",
      expectedVersion,
      mutate: (record) => {
        record.status = "failed";
        record.result = { error: String(reason || "unknown error") };
      },
    });
  }
}

module.exports = ApprovalQueue;
module.exports.ConflictError = ConflictError;
