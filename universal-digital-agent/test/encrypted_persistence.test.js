"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JsonFileStore, AppendLog } = require("../src/core/persistence/fileStore");

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-encrypted-persist-test-"));

  // --- JsonFileStore with encryption ---
  const snapshotPath = path.join(dir, "secret-snapshot.json");
  const store = new JsonFileStore(snapshotPath, { encryptionKey: "test-passphrase-123" });
  store.save({ apiKeyLookingValue: "sk-ant-super-secret-value-do-not-leak", count: 7 });

  const rawOnDisk = fs.readFileSync(snapshotPath, "utf8");
  assert.ok(!rawOnDisk.includes("super-secret"), "the raw file on disk must NOT contain the plaintext secret");
  assert.ok(!rawOnDisk.includes("apiKeyLookingValue"), "not even the field NAME should be visible in ciphertext");
  console.log("PASS: JsonFileStore with an encryption key never writes plaintext to disk");

  const reopened = new JsonFileStore(snapshotPath, { encryptionKey: "test-passphrase-123" });
  const loaded = reopened.load({});
  assert.strictEqual(loaded.apiKeyLookingValue, "sk-ant-super-secret-value-do-not-leak");
  assert.strictEqual(loaded.count, 7);
  console.log("PASS: a new instance with the SAME passphrase correctly decrypts and reloads the data");

  const wrongKeyStore = new JsonFileStore(snapshotPath, { encryptionKey: "wrong-passphrase" });
  assert.throws(() => wrongKeyStore.load({}), "loading with the wrong passphrase must fail, not return garbage or empty silently");
  console.log("PASS: opening the same file with the wrong passphrase throws rather than silently failing open");

  // --- AppendLog with encryption ---
  const logPath = path.join(dir, "secret-log.jsonl");
  const log = new AppendLog(logPath, { encryptionKey: "another-passphrase" });
  log.append({ event: "login", secretToken: "ghp_reallysecrettoken1234567890" });
  log.append({ event: "logout" });

  const rawLog = fs.readFileSync(logPath, "utf8");
  assert.ok(!rawLog.includes("reallysecrettoken"), "append-log entries must be encrypted on disk too, line by line");
  console.log("PASS: AppendLog entries are individually encrypted — no plaintext on disk");

  const reopenedLog = new AppendLog(logPath, { encryptionKey: "another-passphrase" });
  const entries = reopenedLog.loadAll();
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].secretToken, "ghp_reallysecrettoken1234567890");
  console.log("PASS: reloading with the correct passphrase decrypts every line correctly, in order");

  // --- Compaction (rewrite) preserves encryption ---
  log.rewrite([{ event: "compacted-entry" }]);
  const rawAfterCompaction = fs.readFileSync(logPath, "utf8");
  assert.ok(!rawAfterCompaction.includes("compacted-entry"), "even compacted entries must stay encrypted on disk");
  const afterCompaction = new AppendLog(logPath, { encryptionKey: "another-passphrase" }).loadAll();
  assert.strictEqual(afterCompaction.length, 1);
  assert.strictEqual(afterCompaction[0].event, "compacted-entry");
  console.log("PASS: rewrite()/compaction preserves encryption and correctness");

  // --- A store WITHOUT an encryption key never touches this machinery at all (plaintext, unchanged) ---
  const plainPath = path.join(dir, "plain.json");
  new JsonFileStore(plainPath).save({ notSecret: "hello" });
  const rawPlain = fs.readFileSync(plainPath, "utf8");
  assert.ok(rawPlain.includes("hello"), "without an encryption key, storage must remain plain JSON as before");
  console.log("PASS: omitting the encryption key preserves the original plaintext behavior exactly");

  fs.rmSync(dir, { recursive: true, force: true });
}

test("Encrypted persistence tests", async () => {
  main();
});
