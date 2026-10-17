"use strict";
/**
 * Regression: the same OpenTask task failed with a 409 every cycle forever.
 * After MAX_SUBMIT_ATTEMPTS failures it is blocked for PERMANENT_BLOCK_MS,
 * during which submit() makes no network request and discover() skips it.
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

process.env.OPENTASK_REPLACE_DELAY_MS = "0"; // don't wait 2.5s in tests
const strategy = require("../src/core/strategies/openTask");

const DAY = 24 * 60 * 60 * 1000;
const raw = (id) => ({ id, title: "t", budgetAmount: "10", updatedAt: "2026-10-01T00:00:00Z" });

function failingConnector() {
  const calls = { submitBid: 0, withdrawBid: 0 };
  return {
    calls,
    submitBid: async () => {
      calls.submitBid += 1;
      throw new Error('OpenTask POST /agent/bids failed: 409 {"message":"unexpected conflict"}');
    },
    withdrawBid: async () => {
      calls.withdrawBid += 1;
    },
    getMyActiveBids: async () => [],
    getTask: async () => ({}),
    discoverTasks: async () => [raw("bad-task"), raw("other-task")],
  };
}

beforeEach(() => {
  strategy._permanentFailedIds.clear();
  strategy._submitAttempts.clear();
  strategy._attemptedTaskIds.clear();
});

test("3 failed attempts block the task; the 4th is skipped with NO network request", async () => {
  const c = failingConnector();
  for (let i = 0; i < 3; i++) await assert.rejects(() => strategy.submit(c, raw("bad-task"), "p"), /409/);
  assert.strictEqual(c.calls.submitBid, 3);
  assert.ok(strategy._permanentFailedIds.has("bad-task"));

  await assert.rejects(() => strategy.submit(c, raw("bad-task"), "p"), /permanently blocked/);
  assert.strictEqual(c.calls.submitBid, 3, "4th attempt must not reach the network");

  const found = await strategy.discover(c);
  assert.deepStrictEqual(found.map((t) => t.id), ["other-task"]);
});

test("after 24h the block is lifted and a new attempt is allowed", async (t) => {
  const c = failingConnector();
  const start = Date.now();
  for (let i = 0; i < 3; i++) await assert.rejects(() => strategy.submit(c, raw("bad-task"), "p"));

  let offset = DAY - 1000;
  t.mock.method(Date, "now", () => start + offset); // one mock; mutate offset to move time
  await assert.rejects(() => strategy.submit(c, raw("bad-task"), "p"), /permanently blocked/);
  assert.strictEqual(c.calls.submitBid, 3);

  offset = DAY + 1000;
  assert.ok((await strategy.discover(c)).some((x) => x.id === "bad-task"), "discover lists it again");
  await assert.rejects(() => strategy.submit(c, raw("bad-task"), "p"), /409/);
  assert.strictEqual(c.calls.submitBid, 4, "a real attempt was made again");
  assert.ok(!strategy._permanentFailedIds.has("bad-task"), "one failure after unblocking does not re-block immediately");
});

test("other tasks are unaffected, and a success resets the counter", async () => {
  const c = failingConnector();
  for (let i = 0; i < 3; i++) await assert.rejects(() => strategy.submit(c, raw("bad-task"), "p"));

  const ok = { ...failingConnector(), submitBid: async () => ({ id: "bid-1" }) };
  assert.deepStrictEqual(await strategy.submit(ok, raw("good-task"), "p"), { id: "bid-1" });
  assert.ok(!strategy._permanentFailedIds.has("good-task"));

  // two failures then a success -> counter cleared, not blocked later
  const flaky = failingConnector();
  await assert.rejects(() => strategy.submit(flaky, raw("flaky"), "p"));
  await assert.rejects(() => strategy.submit(flaky, raw("flaky"), "p"));
  await strategy.submit({ ...flaky, submitBid: async () => ({ ok: true }) }, raw("flaky"), "p");
  assert.ok(!strategy._submitAttempts.has("flaky"));
});

test("replaceActiveBid waits between withdrawBid and submitBid", async () => {
  process.env.OPENTASK_REPLACE_DELAY_MS = "50";
  const order = [];
  const times = {};
  const c = {
    submitBid: async () => {
      times.submit = Date.now();
      order.push("submit");
      if (order.length === 1) throw new Error("409 you already have an active bid, update it instead");
      return { ok: true };
    },
    getMyActiveBids: async () => [{ id: "b1", taskId: "t-replace" }],
    withdrawBid: async () => {
      times.withdraw = Date.now();
      order.push("withdraw");
    },
  };
  try {
    await strategy.submit(c, raw("t-replace"), "p");
  } finally {
    process.env.OPENTASK_REPLACE_DELAY_MS = "0";
  }
  assert.deepStrictEqual(order, ["submit", "withdraw", "submit"]);
  assert.ok(times.submit - times.withdraw >= 45, "delay between withdraw and resubmit");
});
