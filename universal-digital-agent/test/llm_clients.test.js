"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createFixtureServer } = require("./fixture_server");
const GeminiClient = require("../src/llm/geminiClient");
const GrokClient = require("../src/llm/grokClient");

async function main() {
  const port = 8934;
  const server = await createFixtureServer(port);
  const base = `http://localhost:${port}`;

  try {
    const gemini = new GeminiClient({ apiKey: "fixture-key", apiBase: `${base}/v1beta` });
    const geminiResult = await gemini.generate("system prompt", "user prompt");
    assert.strictEqual(
      geminiResult.text,
      "Executive summary: fixture research output for testing."
    );
    console.log("PASS: GeminiClient parses the real generateContent response shape");

    const grok = new GrokClient({ apiKey: "fixture-key", apiBase: base });
    const grokResult = await grok.generate("system prompt", "user prompt");
    assert.strictEqual(grokResult.text, "Fixture Grok output.");
    console.log("PASS: GrokClient parses the real chat/completions response shape");

    // Unconfigured client should throw a clear, honest error rather than
    // silently returning fake content.
    const unconfigured = new GeminiClient({ apiKey: undefined });
    let threw = false;
    try {
      await unconfigured.generate("s", "u");
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("GEMINI_API_KEY"));
    }
    assert.ok(threw, "Expected unconfigured client to throw");
    console.log("PASS: Unconfigured client fails honestly instead of faking a response");
  } finally {
    server.close();
  }
}

test("All LLM client tests", async () => {
  await main();
});
