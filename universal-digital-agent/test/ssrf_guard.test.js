"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { assertSafeUrl, isBlockedHostnameLiteral, decodeObfuscatedIPv4 } = require("../src/core/ssrfGuard");

test("SSRF guard tests", async (t) => {
  await t.test("private/loopback/link-local/metadata literal IPs are blocked", async () => {
      // --- Literal IP blocking ---
      const blockedLiterals = ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "0.0.0.0"];
      for (const ip of blockedLiterals) {
        assert.strictEqual(isBlockedHostnameLiteral(ip), true, `${ip} should be blocked`);
      }
  });

  await t.test("ordinary public IPs are not blocked", async () => {
    assert.strictEqual(isBlockedHostnameLiteral("8.8.8.8"), false);
      assert.strictEqual(isBlockedHostnameLiteral("93.184.216.34"), false);
  });

  await t.test("decimal/hex IP-literal obfuscation bypasses are caught", async () => {
    // --- Obfuscation bypass attempts ---
      assert.strictEqual(decodeObfuscatedIPv4("2130706433"), "127.0.0.1", "decimal-encoded 127.0.0.1");
      assert.strictEqual(decodeObfuscatedIPv4("0x7f000001"), "127.0.0.1", "hex-encoded 127.0.0.1");
      assert.strictEqual(isBlockedHostnameLiteral("2130706433"), true, "decimal IP obfuscation must still be blocked");
      assert.strictEqual(isBlockedHostnameLiteral("0x7f000001"), true, "hex IP obfuscation must still be blocked");
  });

  await t.test("known dangerous hostnames are blocked", async () => {
    assert.strictEqual(isBlockedHostnameLiteral("localhost"), true);
      assert.strictEqual(isBlockedHostnameLiteral("metadata.google.internal"), true);
  });

  await t.test("non-http(s) protocols are rejected", async () => {
    // --- Protocol rejection ---
      await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), /unsupported protocol/);
      await assert.rejects(() => assertSafeUrl("ftp://example.com/x"), /unsupported protocol/);
  });

  await t.test("cloud metadata endpoint URL is rejected outright", async () => {
    // --- Direct private-IP URL rejection (no DNS needed) ---
      await assert.rejects(() => assertSafeUrl("http://169.254.169.254/latest/meta-data/"), /private\/internal/);
  });

  await t.test("a hostname that resolves to a private IP via DNS is rejected (DNS-rebinding defense)", async () => {
    // --- DNS-rebinding style attack: hostname LOOKS public but resolves to a private IP ---
      const maliciousResolver = async () => ["10.0.0.55"]; // simulates a hostname resolving to an internal IP
      await assert.rejects(
        () => assertSafeUrl("http://looks-public-but-isnt.example.com/", { resolver: maliciousResolver }),
        /resolves to private\/internal address/
      );
  });

  await t.test("a genuinely public hostname passes validation", async () => {
    // --- Legitimate public resolution passes ---
      const benignResolver = async () => ["93.184.216.34"];
      const result = await assertSafeUrl("https://example.com/agent-card.json", { resolver: benignResolver });
      assert.strictEqual(result.hostname, "example.com");
  });

  await t.test("allowPrivate explicit override works for legitimate local testing", async () => {
    // --- allowPrivate escape hatch works for legitimate local testing only when explicitly requested ---
      const allowed = await assertSafeUrl("http://127.0.0.1:8080/test", { allowPrivate: true });
      assert.strictEqual(allowed.hostname, "127.0.0.1");
  });

});
