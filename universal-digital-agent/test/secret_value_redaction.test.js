"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { redact, looksLikeSecretValue } = require("../src/core/auditLog");

function main() {
  // A real credential leaked under a completely unrelated field name —
  // key-name-based redaction alone would miss this.
  const leaked = redact({
    result: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL",
    note: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    comment: "This is just a normal comment with no secrets in it at all.",
    pemBlock: "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----",
  });

  assert.strictEqual(leaked.result, "[REDACTED]", "OpenAI/Anthropic-shaped key under an unrelated field name must be redacted");
  assert.strictEqual(leaked.note, "[REDACTED]", "GitHub token shape under an unrelated field name must be redacted");
  assert.strictEqual(leaked.pemBlock, "[REDACTED]", "PEM private key block must be redacted");
  assert.strictEqual(leaked.comment, "This is just a normal comment with no secrets in it at all.");
  console.log("PASS: secret-SHAPED values are redacted regardless of their field name");

  assert.strictEqual(looksLikeSecretValue("hello world"), false);
  assert.strictEqual(looksLikeSecretValue("molt_abc123def456ghijk"), true);
  console.log("PASS: looksLikeSecretValue distinguishes ordinary text from credential-shaped strings");
}

test("Value-based secret redaction tests", async () => {
  main();
});
