"use strict";

const path = require("node:path");
const { JsonFileStore } = require("./persistence/fileStore");

const DEFAULT_STATE = { globalStopped: false, reason: null, stoppedConnectors: [], autonomousModePaused: false };

/**
 * Global + per-connector kill switch (spec section 21). Checked by the
 * UniversalAgent before every external action (connector call, payment,
 * message, publish).
 *
 * PERSISTENCE: without `persistDir`, this is a pure in-memory flag flip —
 * fine for a single process, but the platform's own docs describe running
 * the agent and the approval/maintenance CLIs as *separate OS processes*.
 * An in-memory-only kill switch flipped in one process is invisible to any
 * other process — an operator hitting "stop" would not actually stop a
 * running agent in a different process. When `persistDir` is set, every
 * mutation is written to disk immediately, and every check re-reads the
 * file first, so a stop issued anywhere is honored everywhere. This still
 * has no dependency on the LLM or network, so it can never itself fail to
 * work for reasons unrelated to disk I/O.
 */
class KillSwitch {
  constructor({ persistDir, encryptionKey } = {}) {
    this._store = persistDir ? new JsonFileStore(path.join(persistDir, "kill-switch.json"), { encryptionKey }) : null;
    const initial = this._store ? this._store.load(DEFAULT_STATE) : { ...DEFAULT_STATE };
    this.globalStopped = initial.globalStopped;
    this._reason = initial.reason ?? null;
    this.stoppedConnectors = new Set(initial.stoppedConnectors || []);
    this.autonomousModePaused = initial.autonomousModePaused;
  }

  _persist() {
    if (!this._store) return;
    this._store.save({
      globalStopped: this.globalStopped,
      reason: this._reason,
      stoppedConnectors: [...this.stoppedConnectors],
      autonomousModePaused: this.autonomousModePaused,
    });
  }

  /** Re-reads the persisted state (if any) so a stop from another process is picked up. */
  _sync() {
    if (!this._store) return;
    const state = this._store.load(DEFAULT_STATE);
    this.globalStopped = state.globalStopped;
    this._reason = state.reason ?? null;
    this.stoppedConnectors = new Set(state.stoppedConnectors || []);
    this.autonomousModePaused = state.autonomousModePaused;
  }

  stopAll(reason = "Manually triggered") {
    this._sync();
    this.globalStopped = true;
    this._reason = reason;
    this._persist();
  }

  resumeAll() {
    this._sync();
    this.globalStopped = false;
    this._reason = null;
    this._persist();
  }

  stopConnector(connectorName) {
    this._sync();
    this.stoppedConnectors.add(connectorName);
    this._persist();
  }

  resumeConnector(connectorName) {
    this._sync();
    this.stoppedConnectors.delete(connectorName);
    this._persist();
  }

  pauseAutonomousMode() {
    this._sync();
    this.autonomousModePaused = true;
    this._persist();
  }

  resumeAutonomousMode() {
    this._sync();
    this.autonomousModePaused = false;
    this._persist();
  }

  /**
   * Call before ANY external action. Throws if blocked so callers can't
   * accidentally ignore a stopped state. Re-syncs from disk first (when
   * persisted) so a stop triggered by a different process is honored
   * immediately, not just eventually.
   */
  assertCanAct(connectorName) {
    this._sync();
    if (this.globalStopped) {
      throw new Error(`GLOBAL_KILL_SWITCH is active${this._reason ? `: ${this._reason}` : ""}.`);
    }
    if (connectorName && this.stoppedConnectors.has(connectorName)) {
      throw new Error(`Connector "${connectorName}" is stopped.`);
    }
  }

  status() {
    this._sync();
    return {
      globalStopped: this.globalStopped,
      stoppedConnectors: [...this.stoppedConnectors],
      autonomousModePaused: this.autonomousModePaused,
    };
  }
}

module.exports = KillSwitch;
