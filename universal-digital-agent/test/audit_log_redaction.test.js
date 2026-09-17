"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { redact } = require("../src/core/auditLog");

function main() {
  const redacted = redact({
    apiKey: "sk-real-secret-value",
    access_token: "abc123",
    tokenUsage: 1132,
    cost: 0,
    nested: { AZURE_CLIENT_SECRET: "shh" },
  });

  assert.strictEqual(redacted.apiKey, "[REDACTED]");
  assert.strictEqual(redacted.access_token, "[REDACTED]");
  assert.strictEqual(redacted.nested.AZURE_CLIENT_SECRET, "[REDACTED]");
  console.log("PASS: real secret-shaped fields are redacted");

  assert.strictEqual(redacted.tokenUsage, 1132, "tokenUsage is a usage count, not a secret — must not be redacted");
  assert.strictEqual(redacted.cost, 0);
  console.log("PASS: legitimate non-secret fields (tokenUsage, cost) survive redaction");
}

test("Audit log redaction tests", async () => {
  main();
});
