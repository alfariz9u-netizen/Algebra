"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const TelegramApprovalBot = require("../src/telegramApprovalBot");
const ApprovalQueue = require("../src/core/approvalQueue");

/**
 * A minimal fake `fetch` that speaks just enough of the Telegram Bot API
 * shape for the bot to work against, and records every call so tests can
 * assert on what was sent — no real network, no real bot token needed.
 */
function makeFakeTelegram() {
  const calls = [];
  const fake = async (url, opts) => {
    const method = url.split("/").pop();
    const params = JSON.parse(opts.body);
    calls.push({ method, params });
    let result = {};
    if (method === "getUpdates") result = [];
    if (method === "sendMessage") result = { message_id: calls.length, chat: { id: params.chat_id } };
    if (method === "answerCallbackQuery") result = true;
    return { json: async () => ({ ok: true, result }) };
  };
  fake.calls = calls;
  return fake;
}

test("TelegramApprovalBot", async (t) => {
  await t.test("refuses to start without an allowlist (fails closed)", () => {
    assert.throws(
      () => new TelegramApprovalBot({ botToken: "t", persistDir: "/tmp/x", allowedChatIds: "", fetchImpl: makeFakeTelegram() }),
      /allowlist/
    );
  });

  await t.test("refuses to start without a persistDir", () => {
    assert.throws(
      () => new TelegramApprovalBot({ botToken: "t", persistDir: undefined, allowedChatIds: "123", fetchImpl: makeFakeTelegram() }),
      /PERSIST_DIR/
    );
  });

  await t.test("notifies allowed chats about a new pending approval, exactly once", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-"));
    try {
      const queue = new ApprovalQueue({ persistDir: dataDir });
      const record = queue.enqueue({
        taskId: "task-1",
        task: { id: "task-1", type: "communication", input: { goal: "reply to customer" } },
        capability: "communication",
        action: "SEND_MESSAGE",
        riskLevel: "MEDIUM",
      });

      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111,222", fetchImpl: fakeFetch });

      const sentCount = await bot.notifyPendingApprovals();
      assert.strictEqual(sentCount, 1);

      const sends = fakeFetch.calls.filter((c) => c.method === "sendMessage");
      assert.strictEqual(sends.length, 2, "one message per allowed chat");
      assert.deepStrictEqual(sends.map((s) => String(s.params.chat_id)).sort(), ["111", "222"]);
      assert.match(sends[0].params.text, new RegExp(record.id));
      assert.ok(sends[0].params.reply_markup.inline_keyboard[0][0].callback_data === `approve:${record.id}`);

      // Calling again must NOT re-notify — already tracked as notified.
      const secondRound = await bot.notifyPendingApprovals();
      assert.strictEqual(secondRound, 0);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("redacts secret-shaped values from the task input preview", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-redact-"));
    try {
      const queue = new ApprovalQueue({ persistDir: dataDir });
      queue.enqueue({
        taskId: "task-2",
        task: { id: "task-2", type: "communication", input: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" } },
        capability: "communication",
        action: "SEND_MESSAGE",
        riskLevel: "MEDIUM",
      });

      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });
      await bot.notifyPendingApprovals();

      const text = fakeFetch.calls.find((c) => c.method === "sendMessage").params.text;
      assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), "the raw secret must never reach Telegram's servers");
      assert.match(text, /REDACTED/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("an unauthorized chat id gets 'Not authorized' and no privileged data", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-unauth-"));
    try {
      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });

      await bot.handleUpdate({ message: { chat: { id: 999 }, text: "/status" } });

      const sends = fakeFetch.calls.filter((c) => c.method === "sendMessage");
      assert.strictEqual(sends.length, 1);
      assert.strictEqual(sends[0].params.text, "Not authorized.");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("an unauthorized callback query is rejected without resolving the approval", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-unauth-cb-"));
    try {
      const queue = new ApprovalQueue({ persistDir: dataDir });
      const record = queue.enqueue({ taskId: "t3", action: "SEND_MESSAGE", riskLevel: "MEDIUM" });

      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });

      await bot.handleUpdate({
        callback_query: { id: "cbq1", data: `approve:${record.id}`, message: { chat: { id: 999 } }, from: { id: 999 } },
      });

      const answered = fakeFetch.calls.find((c) => c.method === "answerCallbackQuery");
      assert.strictEqual(answered.params.text, "Not authorized.");
      const stillPending = new ApprovalQueue({ persistDir: dataDir }).get(record.id);
      assert.strictEqual(stillPending.status, "pending", "an unauthorized chat must not be able to resolve an approval");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("approving a non-resumable approval resolves it without trying to run a task", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-approve-"));
    try {
      const queue = new ApprovalQueue({ persistDir: dataDir });
      const record = queue.enqueue({ taskId: "t4", action: "SEND_MESSAGE", riskLevel: "MEDIUM" }); // no `task` → not resumable

      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });

      await bot.handleUpdate({
        callback_query: { id: "cbq2", data: `approve:${record.id}`, message: { chat: { id: 111 } }, from: { id: 111, username: "alice" } },
      });

      const resolved = new ApprovalQueue({ persistDir: dataDir }).get(record.id);
      assert.strictEqual(resolved.status, "approved");
      assert.strictEqual(resolved.resolvedBy, "telegram:alice");

      const confirmation = fakeFetch.calls.filter((c) => c.method === "sendMessage").pop();
      assert.match(confirmation.params.text, /Approved by telegram:alice/);
      assert.match(confirmation.params.text, /nothing to auto-run/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("denying an approval resolves it as denied and never executes it", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-deny-"));
    try {
      const queue = new ApprovalQueue({ persistDir: dataDir });
      const record = queue.enqueue({
        taskId: "t5",
        task: { id: "t5", type: "communication", input: {} },
        action: "SEND_MESSAGE",
        riskLevel: "MEDIUM",
      });

      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });

      await bot.handleUpdate({
        callback_query: { id: "cbq3", data: `deny:${record.id}`, message: { chat: { id: 111 } }, from: { id: 111, username: "bob" } },
      });

      const resolved = new ApprovalQueue({ persistDir: dataDir }).get(record.id);
      assert.strictEqual(resolved.status, "denied");
      assert.strictEqual(resolved.resolvedBy, "telegram:bob");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("acting on an already-resolved approval is rejected with a clear message, not a crash", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-double-"));
    try {
      const queue = new ApprovalQueue({ persistDir: dataDir });
      const record = queue.enqueue({ taskId: "t6", action: "SEND_MESSAGE", riskLevel: "MEDIUM" });
      queue.resolve(record.id, "approved", "cli-user");

      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });

      await bot.handleUpdate({
        callback_query: { id: "cbq4", data: `deny:${record.id}`, message: { chat: { id: 111 } }, from: { id: 111 } },
      });

      const answered = fakeFetch.calls.find((c) => c.method === "answerCallbackQuery");
      assert.match(answered.params.text, /Already approved/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("/status returns a dashboard summary to an allowed chat", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-status-"));
    try {
      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });

      await bot.handleUpdate({ message: { chat: { id: 111 }, text: "/status" } });

      const sends = fakeFetch.calls.filter((c) => c.method === "sendMessage");
      assert.strictEqual(sends.length, 1);
      assert.match(sends[0].params.text, /autonomy level/);
      assert.match(sends[0].params.text, /kill switch/);
      assert.match(sends[0].params.text, /pending approvals/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("a malformed callback_data is rejected instead of throwing", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uda-telegram-malformed-"));
    try {
      const fakeFetch = makeFakeTelegram();
      const bot = new TelegramApprovalBot({ botToken: "t", persistDir: dataDir, allowedChatIds: "111", fetchImpl: fakeFetch });

      await bot.handleUpdate({
        callback_query: { id: "cbq5", data: "not-a-valid-action", message: { chat: { id: 111 } }, from: { id: 111 } },
      });

      const answered = fakeFetch.calls.find((c) => c.method === "answerCallbackQuery");
      assert.match(answered.params.text, /Malformed/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
