"use strict";

/**
 * Real encryption at rest for the file-backed persistence layer, using
 * only Node's built-in `crypto` module (no external dependency).
 *
 * Design:
 *   - AES-256-GCM (authenticated encryption — tampering is detected, not
 *     just confidentiality).
 *   - Key derived via scrypt from a passphrase (PERSIST_ENCRYPTION_KEY)
 *     plus a random salt generated once per file and stored alongside it
 *     in a sibling `<file>.salt` file.
 *   - A fresh random IV is generated for every single write/append — reusing
 *     an IV with GCM is a real, severe cryptographic failure, so this is
 *     non-negotiable even for append-only logs (each line gets its own IV).
 *
 * Backward compatible by design: if PERSIST_ENCRYPTION_KEY is not set,
 * callers (fileStore.js) skip this module entirely and store plaintext, as
 * before — this is opt-in hardening, not a breaking change to any
 * existing test or deployment.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");

const ALGO = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // recommended for GCM

function getOrCreateSalt(saltPath) {
  try {
    return fs.readFileSync(saltPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const salt = crypto.randomBytes(16);
    fs.writeFileSync(saltPath, salt);
    return salt;
  }
}

/** Derives (and caches, per salt file) a 32-byte key from a passphrase. */
function deriveKey(passphrase, saltPath) {
  const salt = getOrCreateSalt(saltPath);
  return crypto.scryptSync(passphrase, salt, KEY_LENGTH);
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Throws if the ciphertext/tag don't authenticate — tampering or wrong key, never silently returns garbage. */
function decrypt(payload, key) {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

function isEncryptedPayload(obj) {
  return Boolean(obj && typeof obj === "object" && obj.iv && obj.tag && obj.ciphertext);
}

module.exports = { deriveKey, encrypt, decrypt, isEncryptedPayload };
