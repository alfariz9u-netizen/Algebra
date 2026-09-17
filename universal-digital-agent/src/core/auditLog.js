"use strict";

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|password|private[_-]?key|access[_-]?token|auth[_-]?token|bearer)/i;

// Defense in depth: even if a secret ends up under an innocuous key name,
// catch it by its VALUE shape — common real-world credential prefixes/formats.
const SECRET_VALUE_PATTERNS = [
  /^sk-[A-Za-z0-9_-]{20,}$/, // OpenAI/Anthropic-style API keys
  /^ghp_[A-Za-z0-9]{30,}$/, // GitHub personal access token
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^molt_[A-Za-z0-9]{10,}$/, // Molt Market API key
  /^col_[A-Za-z0-9]{10,}$/, // Colony API key
  /^AIza[A-Za-z0-9_-]{30,}$/, // Google API key
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack tokens
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // long base64-looking blob (private keys, JWT segments)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function looksLikeSecretValue(value) {
  if (typeof value !== "string" || value.length < 16) return false;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return looksLikeSecretValue(obj) ? "[REDACTED]" : obj;
  }
  if (typeof obj !== "object") return obj;
  const clone = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      clone[k] = "[REDACTED]";
    } else if (typeof v === "object") {
      clone[k] = redact(v);
    } else if (typeof v === "string" && looksLikeSecretValue(v)) {
      clone[k] = "[REDACTED]";
    } else {
      clone[k] = v;
    }
  }
  return clone;
}

const path = require("node:path");
const { AppendLog } = require("./persistence/fileStore");

class AuditLog {
  /**
   * PERSISTENCE: in-memory by default. Pass `{ persistDir }` to append
   * every entry to disk (JSONL) and reload prior entries on construction —
   * audit history is exactly the kind of record that should NOT silently
   * disappear on restart. Redaction happens before either the in-memory
   * array or the disk file ever sees the entry.
   */
  constructor({ persistDir, encryptionKey } = {}) {
    this._log = persistDir ? new AppendLog(path.join(persistDir, "audit-log.jsonl"), { encryptionKey }) : null;
    this.entries = this._log ? this._log.loadAll() : [];
  }

  record({ agentId, taskId, connector, action, resource, permission, result, riskLevel, approvalStatus, tokenUsage, cost, error }) {
    const entry = {
      timestamp: new Date().toISOString(),
      agentId,
      taskId,
      connector,
      action,
      resource,
      permission,
      result,
      riskLevel,
      approvalStatus,
      tokenUsage,
      cost,
      error: error ? String(error) : undefined,
    };
    const redacted = redact(entry);
    this.entries.push(redacted);
    if (this._log) this._log.append(redacted);
    return entry;
  }

  forTask(taskId) {
    return this.entries.filter((e) => e.taskId === taskId);
  }

  all() {
    return [...this.entries];
  }

  /**
   * The database-cleanup gap this addresses: audit entries were append-only
   * forever, with no way to actually shrink the log. This physically
   * removes entries older than `maxAgeMs` and/or beyond the most recent
   * `maxEntries`, then compacts the on-disk file (via AppendLog.rewrite) —
   * not just trims the in-memory array.
   *
   * @returns {{ before: number, after: number, removed: number }}
   */
  prune({ maxAgeMs, maxEntries } = {}) {
    const before = this.entries.length;
    let kept = this.entries;

    if (maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      kept = kept.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
    }
    if (maxEntries && kept.length > maxEntries) {
      kept = kept.slice(-maxEntries);
    }

    this.entries = kept;
    if (this._log) this._log.rewrite(this.entries);

    return { before, after: this.entries.length, removed: before - this.entries.length };
  }
}

module.exports = { AuditLog, redact, looksLikeSecretValue };
