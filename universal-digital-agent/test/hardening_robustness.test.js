"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { positiveNumber, intervalMs } = require("../src/core/config");
const { JsonFileStore, AppendLog } = require("../src/core/persistence/fileStore");
const { verifyArithmetic } = require("../src/core/verificationLayer");
const { TokenController } = require("../src/core/tokenController");
const { makeRoundRunner } = require("../src/combinedServer");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uda-"));

test("config: NaN / zero / negative interval values fall back instead of causing a busy loop", () => {
  for (const bad of ["abc", "", "0", "-5", undefined, "NaN"]) {
    const v = intervalMs(bad, 60_000, { floorMs: 1000 });
    assert.ok(Number.isFinite(v) && v >= 1000, `${bad} -> ${v}`);
  }
  assert.strictEqual(intervalMs("5000", 60_000, { floorMs: 1000 }), 5000);
  assert.strictEqual(positiveNumber("x", 7), 7);
});

test("fileStore: a torn JSONL line is skipped, a corrupt JSON snapshot is quarantined, boot survives", () => {
  const dir = tmp();
  const log = new AppendLog(path.join(dir, "e.jsonl"));
  log.append({ a: 1 });
  fs.appendFileSync(log.filePath, '{"a":2,"tor');
  fs.appendFileSync(log.filePath, "\n");
  log.append({ a: 3 });
  assert.deepStrictEqual(log.loadAll().map((e) => e.a), [1, 3]);

  const file = path.join(dir, "s.json");
  fs.writeFileSync(file, "{not json");
  assert.deepStrictEqual(new JsonFileStore(file).load({ ok: true }), { ok: true });
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("s.json.corrupt-")));
});

test("fileStore: a WRONG encryption key still throws (never silently discards data)", () => {
  const dir = tmp();
  const file = path.join(dir, "s.json");
  new JsonFileStore(file, { encryptionKey: "right-key" }).save({ secret: 1 });
  assert.throws(() => new JsonFileStore(file, { encryptionKey: "wrong-key" }).load({}));
});

test("verifyArithmetic: thousands separators and chains are not false failures; real errors are caught", () => {
  assert.strictEqual(verifyArithmetic("1,000 + 500 = 1,500").passed, true);
  const bad = verifyArithmetic("We note 2 + 2 = 5 here.");
  const good = verifyArithmetic("Totals: 1,000 + 500 = 1,500 and 100 / 3 = 33.3");
  const flag = (r) => r.passed;
  assert.strictEqual(flag(good), true);
  assert.strictEqual(flag(bad), false);
});

test("TokenController: daily usage survives a restart; per-task map is bounded", () => {
  const dir = tmp();
  const a = new TokenController({}, { persistDir: dir });
  a.preflight("t1", { systemPrompt: "s", userPrompt: "u" });
  a.record("t1", 1234);
  const before = a.getDailyUsage();
  const b = new TokenController({}, { persistDir: dir });
  assert.deepStrictEqual(b.getDailyUsage(), before);
  for (let i = 0; i < 6000; i++) a.record(`k${i}`, 1);
  assert.ok(a.perTaskUsage.size <= 5000);
});

test("round runner: overlapping rounds are skipped and a hung strategy is cut off by the timeout", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const pipeline = { runCycle: async () => { await gate; return {}; } };
  const strategies = [{ name: "s1" }];
  const run = makeRoundRunner({ pipeline, strategies, opts: {}, timeoutMs: 5000 });
  const first = run();
  const second = await run();
  assert.strictEqual(second, false, "second overlapping round must be skipped");
  release();
  await first;

  const hung = makeRoundRunner({ pipeline: { runCycle: () => new Promise(() => {}) }, strategies, opts: {}, timeoutMs: 50 });
  await Promise.race([hung(), new Promise((_, rej) => setTimeout(() => rej(new Error("runner hung")), 2000))]);
});

test("kill switch: AGENT_KILL_SWITCH env halts actions without any disk state", () => {
  const KillSwitch = require("../src/core/killSwitch");
  const Ctor = KillSwitch.KillSwitch || KillSwitch;
  const ks = new Ctor({ persistDir: tmp() });
  process.env.AGENT_KILL_SWITCH = "true";
  try {
    assert.throws(() => ks.assertCanAct("moltbook"));
  } finally {
    delete process.env.AGENT_KILL_SWITCH;
  }
});
