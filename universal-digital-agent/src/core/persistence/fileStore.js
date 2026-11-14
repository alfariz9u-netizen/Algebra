"use strict";

/**
 * Zero-dependency persistence primitives. No SQLite/Postgres driver is
 * bundled (this project's package.json intentionally has no required
 * dependencies), so this uses the filesystem directly:
 *   - JsonFileStore: a full-snapshot key-value store (atomic write via
 *     write-to-temp-then-rename, so a crash mid-write can't corrupt it).
 *   - AppendLog: an append-only JSONL file (one JSON object per line) for
 *     things that only ever grow, like audit log entries and economic
 *     events — cheaper to append than to rewrite a whole snapshot. Also
 *     supports `rewrite()` for compaction (used by retention/pruning).
 *
 * ENCRYPTION AT REST (opt-in): pass `{ encryptionKey: "some passphrase" }`
 * to either class to encrypt everything written to disk with real
 * AES-256-GCM (see encryption.js) — a fresh random IV per write/line, key
 * derived via scrypt from the passphrase and a per-file random salt.
 * Without `encryptionKey`, behavior is unchanged (plaintext), so this is
 * fully backward compatible with every existing caller/test.
 *
 * This is real disk persistence, proven by test/persistence_restart.test.js
 * and test/encrypted_persistence.test.js.
 */

const fs = require("node:fs");
const path = require("node:path");
const { deriveKey, encrypt, decrypt, isEncryptedPayload } = require("./encryption");

/** Moves an unreadable file aside (never deletes it) and returns the fallback. */
function quarantine(filePath, reason, fallback) {
  const target = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, target);
  } catch {
    /* if even that fails, still return the fallback */
  }
  console.error(`[fileStore] ${filePath} is unreadable: ${reason}. Moved to ${target}; continuing with an empty state.`);
  return fallback;
}

class JsonFileStore {
  constructor(filePath, { encryptionKey } = {}) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._key = encryptionKey ? deriveKey(encryptionKey, `${filePath}.salt`) : null;
  }

  load(defaultValue = {}) {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return defaultValue;
      throw new Error(`Failed to load persisted state from ${this.filePath}: ${err.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // A torn/corrupt snapshot (process killed mid-write on a non-atomic filesystem, disk full) used to
      // throw here and crash-loop the whole service at boot. Keep the bad file for forensics, start clean.
      return quarantine(this.filePath, `invalid JSON (${err.message})`, defaultValue);
    }
    if (this._key && isEncryptedPayload(parsed)) {
      // A wrong key or tampering must STILL throw: silently starting empty would overwrite real data.
      return JSON.parse(decrypt(parsed, this._key));
    }
    return parsed;
  }

  save(value) {
    const serialized = this._key ? JSON.stringify(encrypt(JSON.stringify(value), this._key)) : JSON.stringify(value);
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, serialized, "utf8");
    fs.renameSync(tmpPath, this.filePath); // atomic on the same filesystem
  }
}

class AppendLog {
  constructor(filePath, { encryptionKey } = {}) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._key = encryptionKey ? deriveKey(encryptionKey, `${filePath}.salt`) : null;
  }

  _serializeEntry(entry) {
    return this._key ? JSON.stringify(encrypt(JSON.stringify(entry), this._key)) : JSON.stringify(entry);
  }

  _deserializeLine(line) {
    const parsed = JSON.parse(line);
    if (this._key && isEncryptedPayload(parsed)) {
      return JSON.parse(decrypt(parsed, this._key));
    }
    return parsed;
  }

  append(entry) {
    fs.appendFileSync(this.filePath, `${this._serializeEntry(entry)}\n`, "utf8");
  }

  loadAll() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const entries = [];
      let skipped = 0;
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          entries.push(this._deserializeLine(line));
        } catch (err) {
          // A torn last line (killed mid-append) must not make the whole history — or the boot — fail.
          // An authentication failure on an ENCRYPTED line still means wrong key/tampering: surface it.
          if (this._key && /authenticate|auth tag|unable to/i.test(err.message)) {
            throw new Error(`Failed to load append log from ${this.filePath}: ${err.message}`);
          }
          skipped += 1;
        }
      }
      if (skipped > 0) console.error(`[fileStore] ${this.filePath}: skipped ${skipped} unreadable line(s) (torn write?).`);
      return entries;
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw new Error(`Failed to load append log from ${this.filePath}: ${err.message}`);
    }
  }

  /**
   * Atomically replaces the entire log with `entries` — used for
   * compaction/retention pruning, so old/expired records can actually be
   * removed from disk instead of accumulating forever.
   */
  rewrite(entries) {
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const content = entries.map((e) => this._serializeEntry(e)).join("\n") + (entries.length ? "\n" : "");
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}

module.exports = { JsonFileStore, AppendLog };
