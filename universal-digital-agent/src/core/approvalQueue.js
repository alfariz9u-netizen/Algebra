"use strict";

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

/**
 * Turns `pending_human_approval` from a dead-end JSON blob into something a
 * human can actually act on: list what's waiting, approve or deny it, and
 * — for task-level approvals — resume the exact original task afterward.
 *
 * PERSISTENCE MATTERS HERE MORE THAN ANYWHERE ELSE: the process that
 * discovered the task and the human (or CLI) approving it are almost
 * always different processes. Without `persistDir`, approvals only exist
 * in the memory of whichever process created them and can never actually
 * be approved from outside — so this is the clearest real use case for the
 * file-backed persistence added earlier.
 */
class ApprovalQueue {
  constructor({ persistDir, encryptionKey } = {}) {
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "approvals.json"), { encryptionKey }) : null;
    this.records = this._store ? this._store.load([]) : [];
  }

  _persist() {
    if (this._store) this._store.save(this.records);
  }

  /**
   * @param {{ taskId: string, task?: object, capability?: string, connector?: string, action: string, riskLevel: string }} params
   *   `task` (the original task object) is what makes this resumable via
   *   UniversalAgent.resumeTask() — omit it for approvals that don't have
   *   a directly re-runnable task (e.g. some connector-level actions).
   */
  enqueue({ taskId, task, capability, connector, action, riskLevel }) {
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
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };
    this.records.push(record);
    this._persist();
    return record;
  }

  list({ status } = {}) {
    return status ? this.records.filter((r) => r.status === status) : [...this.records];
  }

  get(id) {
    return this.records.find((r) => r.id === id);
  }

  resolve(id, status, resolvedBy) {
    if (!["approved", "denied"].includes(status)) {
      throw new Error(`Invalid resolution status "${status}" — must be "approved" or "denied".`);
    }
    const record = this.get(id);
    if (!record) throw new Error(`No approval request with id "${id}".`);
    if (record.status !== "pending") {
      throw new Error(`Approval "${id}" is already "${record.status}" — cannot resolve it again.`);
    }
    record.status = status;
    record.resolvedAt = new Date().toISOString();
    record.resolvedBy = resolvedBy || null;
    this._persist();
    return record;
  }
}

module.exports = ApprovalQueue;
