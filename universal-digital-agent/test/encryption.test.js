"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deriveKey, encrypt, decrypt, isEncryptedPayload } = require("../src/core/persistence/encryption");

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-encryption-test-"));
  const saltPath = path.join(dir, "test.salt");

  const key1 = deriveKey("correct-passphrase", saltPath);
  const key1Again = deriveKey("correct-passphrase", saltPath);
  assert.deepStrictEqual(key1, key1Again, "deriving the key again from the same salt file must give the same key");
  console.log("PASS: key derivation is deterministic given the same passphrase and salt file");

  const plaintext = JSON.stringify({ secret: "the audit log entry", n: 42 });
  const payload = encrypt(plaintext, key1);
  assert.ok(isEncryptedPayload(payload));
  assert.ok(!payload.ciphertext.includes("secret"), "ciphertext must not contain the plaintext in any recognizable form");
  console.log("PASS: encrypt() produces an authenticated payload that does not leak plaintext");

  const decrypted = decrypt(payload, key1);
  assert.strictEqual(decrypted, plaintext);
  console.log("PASS: decrypt() with the correct key recovers the exact original plaintext");

  // --- Wrong key must fail, not silently return garbage ---
  const wrongKey = deriveKey("wrong-passphrase", saltPath);
  assert.throws(() => decrypt(payload, wrongKey), "decrypting with the wrong key must throw");
  console.log("PASS: decrypting with the wrong key throws (authentication failure), never returns silently-wrong data");

  // --- Tamper detection: flipping a byte in the ciphertext must be caught ---
  const tamperedPayload = { ...payload, ciphertext: payload.ciphertext.slice(0, -4) + "AAAA" };
  assert.throws(() => decrypt(tamperedPayload, key1), "tampered ciphertext must fail authentication");
  console.log("PASS: tampered ciphertext is detected and rejected (GCM authentication), not silently decrypted");

  // --- Every encryption uses a fresh IV, even for identical plaintext ---
  const payload2 = encrypt(plaintext, key1);
  assert.notStrictEqual(payload.iv, payload2.iv, "IV must be fresh every time — reusing an IV with GCM is a real security failure");
  assert.notStrictEqual(payload.ciphertext, payload2.ciphertext);
  console.log("PASS: encrypting the same plaintext twice produces different IVs/ciphertext (no IV reuse)");

  fs.rmSync(dir, { recursive: true, force: true });
}

test("Encryption tests", async () => {
  main();
});
