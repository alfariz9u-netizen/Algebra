"use strict";

/**
 * Safe numeric env parsing. `Number(process.env.X || default)` returns NaN for X="30min" or "abc", and
 * setInterval(fn, NaN) fires every ~1ms — a tight loop that hammers every marketplace API and LLM.
 * Anything that is not a finite number >= min falls back to the default (with a warning).
 */
function positiveNumber(raw, fallback, { min = 0, name } = {}) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n >= min) return n;
  if (name) console.warn(`[config] ${name}="${raw}" is not a valid positive number — using default ${fallback}.`);
  return fallback;
}

/** Interval in ms with a floor so a typo (e.g. 5 instead of 5*60*1000) cannot create a busy loop. */
function intervalMs(raw, fallback, { floorMs = 1000, name } = {}) {
  const n = positiveNumber(raw, fallback, { name });
  return Math.max(floorMs, n);
}

module.exports = { positiveNumber, intervalMs };
