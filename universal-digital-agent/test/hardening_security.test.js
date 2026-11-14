"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { assertSafeUrl, safeFetch, isBlockedHostnameLiteral } = require("../src/core/ssrfGuard");
const A2aClient = require("../src/connectors/a2aClient");
const { createPaidServer, settlementSucceeded } = require("../server");
const { scanForInjection } = require("../src/core/promptInjectionGuard");
const RateLimiter = require("../src/core/rateLimiter");

const publicResolver = async () => ["93.184.216.34"];

test("SSRF guard blocks every IPv6 form of a private/internal address", async () => {
  const blocked = [
    "http://[::1]/", "http://[::]/", "http://[fd00::1]/", "http://[fc00::1]/", "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:192.168.1.1]/", "http://[::ffff:169.254.169.254]/",
    "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://[ff02::1]/", "http://[2001:db8::1]/",
    "http://metadata.google.internal/", "http://db.internal/", "http://printer.local/", "http://a.localhost/",
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertSafeUrl(url, { resolver: publicResolver }), /Refusing to fetch/, `${url} must be blocked`);
  }
  for (const url of ["http://[2606:4700:4700::1111]/", "http://1.1.1.1/", "https://example.com/"]) {
    await assertSafeUrl(url, { resolver: publicResolver });
  }
  assert.strictEqual(isBlockedHostnameLiteral("[::1]"), true);
});

test("a hostname that RESOLVES to an IPv6 loopback/mapped address is blocked too", async () => {
  await assert.rejects(() => assertSafeUrl("https://x.example.com/", { resolver: async () => ["::ffff:7f00:1"] }), /private\/internal/);
  await assert.rejects(() => assertSafeUrl("https://x.example.com/", { resolver: async () => ["::1"] }), /private\/internal/);
});

test("safeFetch re-validates every redirect hop (public URL -> metadata service is refused)", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { status: 302, ok: false, headers: new Headers({ location: "http://169.254.169.254/latest/meta-data" }), body: null, text: async () => "" };
  };
  await assert.rejects(() => safeFetch("https://example.com/card", {}, { resolver: publicResolver, fetchImpl }), /Refusing to fetch/);
  assert.deepStrictEqual(seen, ["https://example.com/card"], "the internal hop must never be requested");
});

test("safeFetch: follows safe redirects, caps redirects, size and time", async () => {
  const ok = (body, extra = {}) => ({ status: 200, ok: true, headers: new Headers(extra), body: new Response(body).body });
  const chain = async (url) =>
    url === "https://a.example.com/" ? { status: 301, ok: false, headers: new Headers({ location: "https://b.example.com/x" }), body: null } : ok("final");
  const r = await safeFetch("https://a.example.com/", {}, { resolver: publicResolver, fetchImpl: chain });
  assert.strictEqual(r.text, "final");

  const loop = async () => ({ status: 302, ok: false, headers: new Headers({ location: "https://a.example.com/" }), body: null });
  await assert.rejects(() => safeFetch("https://a.example.com/", {}, { resolver: publicResolver, fetchImpl: loop, maxRedirects: 2 }), /Too many redirects/);

  await assert.rejects(
    () => safeFetch("https://a.example.com/", {}, { resolver: publicResolver, fetchImpl: async () => ok("x".repeat(500)), maxBytes: 100 }),
    /too large/
  );
  await assert.rejects(
    () => safeFetch("https://a.example.com/", {}, { resolver: publicResolver, fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))), timeoutMs: 30 }),
    /timed out/
  );
});

test("A2A client never reaches an internal service through a redirect and rejects non-JSON", async (t) => {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { status: 302, ok: false, headers: new Headers({ location: "http://[::1]:8080/admin" }), body: null };
  };
  t.after(() => (global.fetch = real));
  t.mock.method(require("node:dns").promises, "lookup", async () => [{ address: "93.184.216.34" }]);
  const client = new A2aClient();
  await assert.rejects(() => client.fetchAgentCard("https://agent.example.com"), /Refusing to fetch/);
  await assert.rejects(() => client.sendMessage({ name: "x", url: "https://agent.example.com/a2a" }, { text: "hi" }), /Refusing to fetch/);
  assert.ok(calls.every((c) => c.startsWith("https://agent.example.com")), `unexpected requests: ${calls}`);
});

test("prompt-injection image rule cannot be bypassed by putting an allowed domain in the query string", () => {
  assert.strictEqual(scanForInjection("![x](https://evil.example/a.png?ref=thecolony.cc)").suspicious, true);
  assert.strictEqual(scanForInjection("![x](https://thecolony.cc/a.png)").suspicious, false);
});

test("RateLimiter drops idle buckets so per-IP keys cannot pile up forever", () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
  rl.maxKeys = 10;
  for (let i = 0; i < 10; i++) rl.tryConsume(`ip-${i}`);
  now = 60_000; // everybody has fully refilled
  rl.tryConsume("new-ip");
  assert.ok(rl.buckets.size <= 2, `expected sweep, got ${rl.buckets.size}`);
});

// ------------------------------------------------------------------ x402 paid endpoint

function paidFixture({ settle, outcome = { status: "success", output: "the answer" }, delay = 0 } = {}) {
  const payments = [];
  const agent = {
    economics: { recordPayment: (p) => payments.push(p) },
    processTask: async () => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return outcome;
    },
  };
  const counts = { verify: 0, settle: 0 };
  const facilitator = {
    status: () => "CONNECTED",
    buildRequirements: () => ({ scheme: "exact", maxAmountRequired: "50000" }),
    verify: async () => (counts.verify++, { isValid: true }),
    settle: async () => (counts.settle++, settle ? settle() : { success: true, transaction: "0xabc" }),
  };
  const server = createPaidServer({ getAgent: async () => agent, facilitator, priceUsd: 0.05 });
  return { server, payments, counts };
}
async function call(server, { payment = "e30=", body = { question: "q?" } } = {}) {
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/paid/research`, { method: "POST", headers: { "x-payment": payment, host: "x.example.com" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("x402: success returns the answer once and records the payment in economics", async (t) => {
  const f = paidFixture();
  t.after(() => f.server.close());
  const r = await call(f.server);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.answer, "the answer");
  assert.strictEqual(f.payments.length, 1);
  assert.strictEqual(f.payments[0].amountUsd, 0.05);
  assert.strictEqual(f.payments[0].txSignature, "0xabc");
});

test("x402: a failed settlement never hands over the answer for free", async (t) => {
  const f = paidFixture({ settle: () => ({ success: false, errorReason: "insufficient_funds" }) });
  t.after(() => f.server.close());
  const r = await call(f.server);
  assert.strictEqual(r.status, 402);
  assert.ok(!r.body.answer);
  assert.strictEqual(f.payments.length, 0);
  assert.strictEqual(settlementSucceeded({ data: [{ success: true }] }), true);
  assert.strictEqual(settlementSucceeded({}), false);
});

test("x402: ten concurrent requests with the SAME payment are served at most once", async (t) => {
  const f = paidFixture({ delay: 50 });
  t.after(() => f.server.close());
  await new Promise((r) => f.server.listen(0, r));
  const { port } = f.server.address();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => fetch(`http://127.0.0.1:${port}/paid/research`, { method: "POST", headers: { "x-payment": "eyJuIjogInNhbWUifQ==" }, body: JSON.stringify({ question: "q" }) }).then((r) => r.status))
  );
  assert.strictEqual(results.filter((s) => s === 200).length, 1, `statuses: ${results}`);
  assert.strictEqual(f.counts.settle, 1);
});

test("x402: unfinished work releases the payment for a retry; oversized bodies are refused", async (t) => {
  const f = paidFixture({ outcome: { status: "failed", reason: "QA" } });
  t.after(() => f.server.close());
  const r1 = await call(f.server, { payment: "eyJuIjogInJldHJ5In0=" });
  assert.strictEqual(r1.status, 502);
  assert.strictEqual(f.counts.settle, 0, "no money moves for a failed task");
  // The server may answer 413 or cut the connection mid-upload; either way the body is never processed.
  const r2 = await fetch(`http://127.0.0.1:${f.server.address().port}/paid/research`, { method: "POST", headers: { "x-payment": "eyJuIjoiYmlnIn0=" }, body: JSON.stringify({ question: "x".repeat(70 * 1024) }) }).then((r) => r.status, () => "reset");
  assert.ok(r2 === 413 || r2 === "reset", `got ${r2}`);
  assert.strictEqual(f.counts.settle, 0);
});
