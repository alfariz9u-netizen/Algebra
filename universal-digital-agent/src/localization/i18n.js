"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LOCALE = process.env.LOCALE || "en-US";
const DICT_DIR = path.join(__dirname, "dictionaries");

const cache = new Map();

function loadDictionary(locale) {
  if (cache.has(locale)) return cache.get(locale);

  const filePath = path.join(DICT_DIR, `${locale}.json`);
  if (!fs.existsSync(filePath)) {
    if (locale !== DEFAULT_LOCALE) {
      // Fall back to default locale rather than failing the request.
      return loadDictionary(DEFAULT_LOCALE);
    }
    throw new Error(`Missing required default locale dictionary: ${DEFAULT_LOCALE}`);
  }

  const dict = JSON.parse(fs.readFileSync(filePath, "utf8"));
  cache.set(locale, dict);
  return dict;
}

/**
 * Render a templated, localized message key.
 * All client-facing and internal status text MUST go through this function —
 * never hard-code English (or any other language) strings directly in agent logic.
 */
function t(key, vars = {}, locale = DEFAULT_LOCALE) {
  const dict = loadDictionary(locale);
  const template = dict[key] || loadDictionary(DEFAULT_LOCALE)[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : `{${name}}`
  );
}

module.exports = { t, DEFAULT_LOCALE };
