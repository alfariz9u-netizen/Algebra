"use strict";

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

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

class ApprovalQueue {
  constructor({ persistDir, encryptionKey } = {}) {
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "approvals.json"), { encryptionKey }) : null;
    this.records = this._store ? this._store.load([]) : [];
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
        record.result = {
          error: `Execution timed out after ${Math.round(elapsed / 1000)}s (stuck in "executing" since ${record.executingAt} — the process handling it likely crashed or hung before calling consume()/fail()).`,
        };
        changed = true;
      }
    }
    if (changed) this._persist();
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
    mutate(record);
    record.version += 1;
    this._persist();
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
