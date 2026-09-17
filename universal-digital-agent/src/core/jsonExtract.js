"use strict";

/**
 * Loosely extracts a JSON object from LLM output that is *supposed* to be
 * JSON but may be wrapped in minor formatting noise a model commonly adds:
 * ```json fences, ``` fences with no language tag, a leading/trailing
 * sentence, or stray whitespace. This is intentionally only used for
 * meta-output like QA grading (a score + reasoning), never for a
 * capability's actual deliverable — a deliverable that promises JSON
 * should be held to a strict `JSON.parse`, which is what
 * `verificationLayer.verifyJsonStructure` still does.
 *
 * Strategy, in order, each only attempted if the previous one fails:
 *   1. Parse the trimmed text as-is.
 *   2. Strip a ```json / ``` fence (with or without a language tag) and
 *      retry.
 *   3. Extract the first balanced-looking `{...}` substring and retry —
 *      this survives a model prefacing or following the JSON with prose.
 *
 * Throws the original parse error (from the raw-text attempt) if every
 * strategy fails, so callers get a message that reflects the real input.
 */
function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();

  const attempts = [
    () => raw,
    () => raw.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim(),
    () => {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) return null;
      return raw.slice(start, end + 1);
    },
  ];

  let firstError;
  for (const attempt of attempts) {
    const candidate = attempt();
    if (candidate === null || candidate === undefined || candidate === "") continue;
    try {
      return JSON.parse(candidate);
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  throw firstError || new Error("No JSON content found.");
}

module.exports = { parseJsonLoose };
