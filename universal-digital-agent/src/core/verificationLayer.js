"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Verification layer (spec section 7). Deterministic checks are used
 * wherever the capability allows it; only capabilities that produce
 * genuinely open-ended prose (research, content) fall back to an LLM grading
 * call — and even then it's a single grading call, not a second "agreeing"
 * agent debating the first.
 */

function verifyCode(text) {
  const codeBlockMatch = text.match(/```(\w+)?\n([\s\S]*?)```/);
  if (!codeBlockMatch) {
    return { passed: false, checks: ["No fenced code block found in output."] };
  }
  const lang = (codeBlockMatch[1] || "").toLowerCase();
  const code = codeBlockMatch[2];

  if (!["js", "javascript"].includes(lang)) {
    return { passed: true, checks: [`Fenced code block found (${lang || "unspecified"} lang); skipping node syntax check.`] };
  }

  const tmpFile = path.join(os.tmpdir(), `verify_${Date.now()}.js`);
  fs.writeFileSync(tmpFile, code);
  try {
    execFileSync("node", ["--check", tmpFile]);
    return { passed: true, checks: ["Syntax check passed (node --check)."] };
  } catch (err) {
    return { passed: false, checks: [`Syntax check failed: ${err.message}`] };
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function verifyJsonStructure(text, requiredKeys = []) {
  try {
    const parsed = JSON.parse(text);
    const missing = requiredKeys.filter((k) => !(k in parsed));
    if (missing.length > 0) {
      return { passed: false, checks: [`Missing required keys: ${missing.join(", ")}`] };
    }
    return { passed: true, checks: ["JSON parsed and required keys present."] };
  } catch (err) {
    return { passed: false, checks: [`Not valid JSON: ${err.message}`] };
  }
}

function verifyNonEmpty(text) {
  const passed = Boolean(text && text.trim().length > 0);
  return { passed, checks: [passed ? "Output is non-empty." : "Output is empty."] };
}

function verifyNoUnverifiedClaimSuppressed(text) {
  // If the model itself flagged something as unable to verify, that's a
  // PASS for honesty — it means the anti-hallucination instruction worked,
  // not a failure. This just surfaces it for QA visibility.
  const flagged = /unable to verify/i.test(text);
  return { passed: true, checks: [flagged ? "Model explicitly flagged unverifiable content." : "No explicit unverifiable-content flag."], flagged };
}

/**
 * Deterministic financial/numeric verification: recomputes any "X = A op B"
 * style arithmetic claims found in the text and checks them, rather than
 * trusting the model's arithmetic.
 */
function verifyArithmetic(rawText) {
  // Normalise how humans write numbers: "1,000 + 500 = 1,500" used to parse as "000 + 500 = 1" (a false
  // failure of correct math), and "$" prefixes hid the second operand entirely.
  const text = String(rawText || "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/[$€£]\s?/g, "");
  // A chain such as "1 + 2 + 3 = 6" must not be sliced into the bogus claim "2 + 3 = 6": an operand that is
  // itself preceded/followed by another operator is not a simple "A op B = C" claim and is skipped.
  const pattern = /(?<![\d.]\s*[*+/-]\s*)(?<![\d.])(-?\d+(?:\.\d+)?)\s*([*+/-])\s*(-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)(?!\s*[*+/-]\s*\d)/g;
  const checks = [];
  let passed = true;
  let match;
  while ((match = pattern.exec(text))) {
    const [, a, op, b, claimed] = match;
    const A = parseFloat(a);
    const B = parseFloat(b);
    const claimedVal = parseFloat(claimed);
    let actual;
    switch (op) {
      case "+": actual = A + B; break;
      case "-": actual = A - B; break;
      case "*": actual = A * B; break;
      case "/": actual = A / B; break;
    }
    // Tolerance follows the precision the author wrote: "100 / 3 = 33.3" is right to one decimal place.
    const decimals = (claimed.split(".")[1] || "").length;
    const ok = Number.isFinite(actual) && Math.abs(actual - claimedVal) <= 0.5 * 10 ** -decimals + 1e-9;
    checks.push(`${a} ${op} ${b} = ${claimed} -> ${ok ? "correct" : `incorrect (actual ${actual})`}`);
    if (!ok) passed = false;
  }
  if (checks.length === 0) checks.push("No inline arithmetic claims found to verify.");
  return { passed, checks };
}

/**
 * Entry point used by the UniversalAgent. Picks the deterministic check(s)
 * appropriate to the capability; always includes a non-empty check.
 */
function verify(capabilityName, outputText) {
  const results = [verifyNonEmpty(outputText), verifyNoUnverifiedClaimSuppressed(outputText)];

  if (["coding", "debugging"].includes(capabilityName)) {
    results.push(verifyCode(outputText));
  }
  if (["financialAnalysis", "dataAnalysis"].includes(capabilityName)) {
    results.push(verifyArithmetic(outputText));
  }

  const passed = results.every((r) => r.passed);
  const checks = results.flatMap((r) => r.checks);
  return { passed, checks };
}

module.exports = { verify, verifyCode, verifyJsonStructure, verifyNonEmpty, verifyArithmetic };
