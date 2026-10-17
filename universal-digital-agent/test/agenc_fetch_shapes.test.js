"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const AgencAdapter = require("../src/connectors/agenc");

async function fetchWith(t, body) {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => body });
  t.after(() => {
    global.fetch = real;
  });
  const warn = t.mock.method(console, "warn", () => {});
  const out = await new AgencAdapter().fetchIncomingTasks();
  return { out, warnings: warn.mock.calls.map((c) => c.arguments[0]) };
}

const task = { taskId: "t1", reward: 5 };

for (const [name, body] of [
  ["bare array", [task]],
  ["{tasks}", { tasks: [task] }],
  ["{items}", { items: [task] }],
  ["{data}", { data: [task] }],
]) {
  test(`fetchIncomingTasks accepts ${name}`, async (t) => {
    const { out, warnings } = await fetchWith(t, body);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, "t1");
    assert.strictEqual(warnings.length, 0);
  });
}

test("unexpected object shape returns [] with a warning instead of throwing", async (t) => {
  const { out, warnings } = await fetchWith(t, { error: "x", message: "y" });
  assert.deepStrictEqual(out, []);
  assert.match(warnings[0], /\[agenc\] unexpected response: error,message/);
});

test("{tasks: {}} (non-array) and null do not throw", async (t) => {
  assert.deepStrictEqual((await fetchWith(t, { tasks: {} })).out, []);
  assert.deepStrictEqual((await fetchWith(t, null)).out, []);
});
