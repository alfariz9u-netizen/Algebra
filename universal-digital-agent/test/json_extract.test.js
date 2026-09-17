"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { parseJsonLoose } = require("../src/core/jsonExtract");

/**
 * Regression coverage for the fragile QA-grading JSON parse, which used to
 * be a single `JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, ""))`
 * — any formatting variation a model commonly produces (no language tag on
 * the fence, leading/trailing prose, stray whitespace) made a perfectly
 * valid QA verdict fail closed for the wrong reason (a parsing bug, not an
 * actual quality problem).
 */
test("parseJsonLoose tolerates common LLM output formatting", async (t) => {
  await t.test("parses plain, unwrapped JSON", () => {
    const result = parseJsonLoose('{"score": 92, "reasoning": "solid"}');
    assert.deepStrictEqual(result, { score: 92, reasoning: "solid" });
  });

  await t.test("strips a ```json fence with a language tag", () => {
    const result = parseJsonLoose('```json\n{"score": 80, "reasoning": "ok"}\n```');
    assert.deepStrictEqual(result, { score: 80, reasoning: "ok" });
  });

  await t.test("strips a plain ``` fence with no language tag", () => {
    const result = parseJsonLoose('```\n{"score": 75, "reasoning": "fine"}\n```');
    assert.deepStrictEqual(result, { score: 75, reasoning: "fine" });
  });

  await t.test("extracts JSON preceded and followed by prose", () => {
    const result = parseJsonLoose(
      'Here is my evaluation:\n{"score": 88, "reasoning": "good structure"}\nLet me know if you need more detail.'
    );
    assert.deepStrictEqual(result, { score: 88, reasoning: "good structure" });
  });

  await t.test("handles surrounding whitespace and newlines", () => {
    const result = parseJsonLoose('\n\n   {"score": 60, "reasoning": "weak"}   \n\n');
    assert.deepStrictEqual(result, { score: 60, reasoning: "weak" });
  });

  await t.test("still throws a clear error on genuinely non-JSON output", () => {
    assert.throws(() => parseJsonLoose("I refuse to answer in JSON."), /Unexpected token|JSON/);
  });

  await t.test("throws on empty input rather than returning something misleading", () => {
    assert.throws(() => parseJsonLoose(""));
  });
});
