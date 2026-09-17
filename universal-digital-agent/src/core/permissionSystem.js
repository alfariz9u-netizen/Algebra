"use strict";

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

/**
 * Deny-by-default permission system (spec sections 17-18). Deterministic,
 * no LLM involved. Grants are scoped to Agent + Task + Resource + Action +
 * Time and expire automatically.
 *
 * Note on what "deny-by-default" actually guarantees here: grants in this
 * class are self-issued by the same process that checks them (there is no
 * separate human/authority actor inside this class itself). The real
 * guarantee comes from *when* `UniversalAgent.processTask` is allowed to
 * call `grant()` at all — only after the risk/autonomy gate in
 * `riskEngine.js` has already been cleared (see universalAgent.js). This
 * class is the bookkeeping/expiry layer for that decision, not the
 * decision-maker.
 *
 * PERSISTENCE: without `persistDir`, grants live in memory only, so a
 * revoke issued from a different process (e.g. an operator tool) would
 * never be seen by a running agent process. With `persistDir` set, grants
 * are written to disk on every mutation and re-read on every check, so
 * revocation is visible across processes, and grants also survive restarts.
 */
class PermissionSystem {
  constructor({ persistDir, encryptionKey } = {}) {
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "permission-grants.json"), { encryptionKey }) : null;
    this.grants = new Map(Object.entries(this._store ? this._store.load({}) : {}));
  }

  _persist() {
    if (!this._store) return;
    this._store.save(Object.fromEntries(this.grants));
  }

  _sync() {
    if (!this._store) return;
    this.grants = new Map(Object.entries(this._store.load({})));
  }

  grant({ agentId, taskId, resource, action, durationMs, riskLevel }) {
    if (!PERMISSIONS.includes(action)) {
      throw new Error(`Unknown permission action: ${action}`);
    }
    this._sync();
    const grantId = `${agentId}:${taskId}:${resource}:${action}`;
    const grant = {
      grantId,
      agentId,
      taskId,
      resource,
      action,
      riskLevel: riskLevel || "LOW",
      grantedAt: Date.now(),
      expiresAt: durationMs ? Date.now() + durationMs : null,
      status: "APPROVED",
    };
    this.grants.set(grantId, grant);
    this._persist();
    return grant;
  }

  revoke(grantId) {
    this._sync();
    const grant = this.grants.get(grantId);
    if (grant) {
      grant.status = "REVOKED";
      this._persist();
    }
    return grant;
  }

  revokeAllForTask(taskId) {
    this._sync();
    let changed = false;
    for (const grant of this.grants.values()) {
      if (grant.taskId === taskId) {
        grant.status = "REVOKED";
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  /**
   * Deny by default: only APPROVED, unexpired grants for the exact
   * agent+task+resource+action pass. Re-syncs from disk first (when
   * persisted) so an external revoke is honored immediately.
   */
  check({ agentId, taskId, resource, action }) {
    this._sync();
    const grantId = `${agentId}:${taskId}:${resource}:${action}`;
    const grant = this.grants.get(grantId);
    if (!grant) return { allowed: false, reason: "No grant exists for this agent/task/resource/action." };
    if (grant.status !== "APPROVED") return { allowed: false, reason: `Grant status is ${grant.status}.` };
    if (grant.expiresAt && Date.now() > grant.expiresAt) {
      grant.status = "EXPIRED";
      this._persist();
      return { allowed: false, reason: "Grant expired." };
    }
    return { allowed: true, grant };
  }
}

const PERMISSIONS = Object.freeze([
  "READ_PUBLIC_WEB",
  "READ_FILES",
  "READ_EMAIL",
  "SEND_EMAIL",
  "READ_GITHUB",
  "WRITE_GITHUB",
  "CREATE_PULL_REQUEST",
  "PUBLISH",
  "SEND_MESSAGE",
  "USE_EXTERNAL_API",
  "USE_MCP_TOOL",
  "USE_A2A",
  "SUBMIT_TASK",
  "RECEIVE_PAYMENT",
  "MAKE_PAYMENT",
  "WITHDRAW_FUNDS",
  "MODIFY_AGENT",
  "MODIFY_SYSTEM",
]);

module.exports = { PermissionSystem, PERMISSIONS };
