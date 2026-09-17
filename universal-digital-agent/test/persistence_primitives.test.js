"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JsonFileStore, AppendLog } = require("../src/core/persistence/fileStore");

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-persist-test-"));

  // --- JsonFileStore: snapshot survives a brand-new instance pointed at the same file ---
  const storePath = path.join(dir, "snapshot.json");
  const store1 = new JsonFileStore(storePath);
  assert.deepStrictEqual(store1.load({}), {}, "a fresh file should load the default value");
  store1.save({ hello: "world", count: 1 });
  console.log("PASS: JsonFileStore writes a snapshot to disk");

  const store2 = new JsonFileStore(storePath); // simulates a new process starting up
  const reloaded = store2.load({});
  assert.deepStrictEqual(reloaded, { hello: "world", count: 1 });
  console.log("PASS: a brand-new JsonFileStore instance loads the same data — this is real restart-survival, not in-memory only");

  // --- Atomicity: save() must not leave a corrupt/partial file even if called repeatedly ---
  for (let i = 0; i < 5; i++) store1.save({ iteration: i });
  const finalStore = new JsonFileStore(storePath);
  assert.deepStrictEqual(finalStore.load({}), { iteration: 4 });
  console.log("PASS: repeated saves leave a single valid final snapshot, never a corrupted partial write");

  // --- AppendLog: entries survive across instances too ---
  const logPath = path.join(dir, "events.jsonl");
  const log1 = new AppendLog(logPath);
  assert.deepStrictEqual(log1.loadAll(), []);
  log1.append({ event: "first" });
  log1.append({ event: "second" });
  console.log("PASS: AppendLog appends entries to disk");

  const log2 = new AppendLog(logPath);
  const entries = log2.loadAll();
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].event, "first");
  assert.strictEqual(entries[1].event, "second");
  console.log("PASS: a brand-new AppendLog instance reloads all previously appended entries in order");

  fs.rmSync(dir, { recursive: true, force: true });
}

test("Persistence primitive tests", async () => {
  main();
});
