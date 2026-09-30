"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { estimateCostUsd, DailyQuotaTracker, PRICING_TABLE } = require("../src/core/llmPricing");

test("estimateCostUsd: computes a real, non-zero dollar cost for Grok (the only genuinely paid provider) with no quota tracker", () => {
  const cost = estimateCostUsd("GrokClient", "grok-4-fast", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(cost > 0, "Grok must never be free — it has no free tier in this project");
  // Exact figure depends on PRICING_TABLE.GrokClient.__default, which is
  // intentionally the conservative/expensive current-flagship rate.
  assert.strictEqual(cost, PRICING_TABLE.GrokClient.__default.input + PRICING_TABLE.GrokClient.__default.output);
});

test("estimateCostUsd: computes real Groq/Gemini paid rates correctly when no quota tracker is given (worst-case / pre-bid estimate mode)", () => {
  const groqCost = estimateCostUsd("GroqClient", "openai/gpt-oss-120b", { inputTokens: 2000, outputTokens: 500 });
  const expectedGroq = (2000 / 1e6) * 0.15 + (500 / 1e6) * 0.6;
  assert.strictEqual(groqCost, Math.round(expectedGroq * 1e6) / 1e6);

  const geminiCost = estimateCostUsd("GeminiClient", "gemini-3.5-flash-lite", { inputTokens: 2000, outputTokens: 500 });
  const expectedGemini = (2000 / 1e6) * 0.3 + (500 / 1e6) * 2.5;
  assert.strictEqual(geminiCost, Math.round(expectedGemini * 1e6) / 1e6);
});

test("estimateCostUsd: unknown provider returns 0 rather than inventing a price", () => {
  assert.strictEqual(estimateCostUsd("SomeFutureProviderClient", "mystery-model", { inputTokens: 1000, outputTokens: 1000 }), 0);
  assert.strictEqual(estimateCostUsd(null, null, {}), 0);
});

test("DailyQuotaTracker: a call inside the free quota costs $0 and consumes exactly one unit of quota", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-quota-"));
  try {
    const tracker = new DailyQuotaTracker({ persistDir: tmpDir });
    const before = tracker.remainingToday("GroqClient");
    assert.ok(before > 0, "Groq must start the day with real free quota");

    const cost = estimateCostUsd("GroqClient", "openai/gpt-oss-120b", { inputTokens: 100000, outputTokens: 50000 }, tracker);
    assert.strictEqual(cost, 0, "a call inside the free quota must cost exactly $0, even for a large token count");
    assert.strictEqual(tracker.remainingToday("GroqClient"), before - 1, "exactly one quota unit must be consumed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DailyQuotaTracker: once the free quota is exhausted, further calls are priced for real", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-quota-"));
  try {
    const tracker = new DailyQuotaTracker({ persistDir: tmpDir });
    // Drain today's quota directly rather than looping 500-1000 real calls.
    while (tracker.remainingToday("GeminiClient") > 0) tracker.recordRequest("GeminiClient");
    assert.strictEqual(tracker.remainingToday("GeminiClient"), 0);

    const cost = estimateCostUsd("GeminiClient", "gemini-3.5-flash-lite", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, tracker);
    assert.ok(cost > 0, "once the real free quota is gone, the call must be priced, not silently treated as free");
    assert.strictEqual(cost, 0.3 + 2.5);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DailyQuotaTracker: quota state survives a process restart (persisted to disk, not just memory)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-quota-"));
  try {
    const t1 = new DailyQuotaTracker({ persistDir: tmpDir });
    t1.recordRequest("GroqClient");
    t1.recordRequest("GroqClient");
    const usedAfterTwo = t1.remainingToday("GroqClient");

    // Simulate a restart: brand new tracker instance, same persistDir.
    const t2 = new DailyQuotaTracker({ persistDir: tmpDir });
    assert.strictEqual(
      t2.remainingToday("GroqClient"),
      usedAfterTwo,
      "a fresh process must see the SAME quota state, not reset to a full quota (which would silently under-count real usage and mis-price calls as free)"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DailyQuotaTracker: Grok has no tracked free quota (Infinity) since it's never free in this project", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-quota-"));
  try {
    const tracker = new DailyQuotaTracker({ persistDir: tmpDir });
    assert.strictEqual(tracker.remainingToday("GrokClient"), Infinity);
    // And therefore a "quota-aware" estimate for Grok must still be priced.
    const cost = estimateCostUsd("GrokClient", "grok-4", { inputTokens: 1_000_000, outputTokens: 0 }, tracker);
    assert.ok(cost > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
