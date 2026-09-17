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

  status(name) {
    const entry = this._connectors.get(name);
    if (!entry) return STATUS.NOT_SUPPORTED;
    return entry.statusFn ? entry.statusFn() : STATUS.NOT_CONNECTED;
  }

  capabilities(name) {
    const entry = this._connectors.get(name);
    return entry ? entry.capabilities : [];
  }

  /** True only if the connector is CONNECTED and the operation is in its declared capability list. */
  supports(name, operation) {
    if (this.status(name) !== STATUS.CONNECTED) return false;
    return this.capabilities(name).includes(operation);
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
