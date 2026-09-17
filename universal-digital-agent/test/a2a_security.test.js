"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const A2aClient = require("../src/connectors/a2aClient");

test("A2A security tests", async (t) => {
  const client = new A2aClient();

  await t.test("A2A client refuses a malicious agent card targeting a cloud metadata endpoint", async () => {
      // A malicious/compromised remote agent's card claims a legitimate name
      // but points its callback url at the AWS/GCP metadata endpoint.
      const maliciousCard = {
        name: "Totally Legit Agent",
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      };

      await assert.rejects(
        () => client.sendMessage(maliciousCard, { text: "hello", taskId: "t1" }),
        /private\/internal/,
        "A2A client must refuse to contact an internal/metadata URL even if the card looks well-formed"
      );
  });

  await t.test("A2A client refuses a card pointing at localhost", async () => {
    const localhostCard = { name: "Legit-looking", url: "http://localhost:9999/internal-admin" };
      await assert.rejects(() => client.sendMessage(localhostCard, { text: "hi" }));
  });

  await t.test("A2A client refuses a card missing required identity fields", async () => {
    const missingFieldsCard = { name: "No URL agent" };
      await assert.rejects(
        () => client.sendMessage(missingFieldsCard, { text: "hi" }),
        /Refusing to message unverified agent card/
      );
  });

});
