"use strict";

/**
 * Connector registry (spec sections 9-11). Every connector declares an
 * explicit status rather than the agent assuming it works. Statuses:
 *   CONNECTED, NOT_CONNECTED, CREDENTIAL_REQUIRED, NOT_SUPPORTED,
 *   DISABLED, HUMAN_APPROVAL_REQUIRED
 */

const STATUS = Object.freeze({
  CONNECTED: "CONNECTED",
  NOT_CONNECTED: "NOT_CONNECTED",
  CREDENTIAL_REQUIRED: "CREDENTIAL_REQUIRED",
  NOT_SUPPORTED: "NOT_SUPPORTED",
  DISABLED: "DISABLED",
  HUMAN_APPROVAL_REQUIRED: "HUMAN_APPROVAL_REQUIRED",
});

class ConnectorRegistry {
  constructor() {
    this._connectors = new Map(); // name -> { instance, capabilities, statusFn }
  }

  register(name, { instance, capabilities, statusFn }) {
    this._connectors.set(name, { instance, capabilities, statusFn });
  }

  get(name) {
    const entry = this._connectors.get(name);
    if (!entry) throw new Error(`Unknown connector: ${name}`);
    return entry.instance;
  }

  /**
   * FIX: safe counterpart to get() for optional/best-effort features
   * (the Supabase lesson-memory hook and the automatic Moltbook post
   * hook in universalAgent.js). get() intentionally throws for anything
   * NOT explicitly registered — correct for real capability execution,
   * where a missing connector is a bug — but a bespoke/minimal agent
   * (every unit test, and both src/approvalCli.js and
   * src/maintenanceCli.js, which construct `new UniversalAgent()`
   * directly instead of via buildAgent()) legitimately registers only
   * the connectors it needs. Calling get() unguarded for an optional
   * side-feature crashed processTask()/resumeTask() entirely for such
   * agents — confirmed via `node src/approvalCli.js resume <id>`, which
   * always throws "Unknown connector: supabase" even for tasks that
   * have nothing to do with Supabase. has()+get() (or this helper) is
   * the correct way to check for an optional connector; get() alone is
   * only safe once you already know it's registered.
   */
  getOptional(name) {
    return this._connectors.has(name) ? this._connectors.get(name).instance : null;
  }

  status(name, operation) {
    const entry = this._connectors.get(name);
    if (!entry) return STATUS.NOT_SUPPORTED;
    return entry.statusFn ? entry.statusFn(operation) : STATUS.NOT_CONNECTED;
  }

  capabilities(name) {
    const entry = this._connectors.get(name);
    return entry ? entry.capabilities : [];
  }

  /**
   * FIX (carried over from the earlier audit round, re-applied here
   * since this codebase branch never had it): passes `operation` through
   * to status() so a connector with one genuinely free/keyless operation
   * and one that needs real credentials (agentverse.js's listAgents vs.
   * register; agenc.js's fetchIncomingTasks vs. submitDeliverable) isn't
   * blocked on the free one just because the paid one isn't configured
   * yet. A statusFn that ignores its argument (most connectors) behaves
   * exactly as before.
   */
  supports(name, operation) {
    if (!this.capabilities(name).includes(operation)) return false;
    return this.status(name, operation) === STATUS.CONNECTED;
  }

  list() {
    return [...this._connectors.entries()].map(([name, entry]) => ({
      name,
      status: this.status(name),
      capabilities: entry.capabilities,
    }));
  }
}

module.exports = { ConnectorRegistry, STATUS };
