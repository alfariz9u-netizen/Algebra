"use strict";

const dns = require("node:dns").promises;

/**
 * SSRF (Server-Side Request Forgery) protection. This matters most for
 * connectors that follow URLs supplied by an UNTRUSTED remote party —
 * concretely: A2A agent-card discovery, where a malicious "agent" can hand
 * back a `url` pointing at internal infrastructure (e.g. a cloud metadata
 * endpoint) hoping the caller blindly POSTs to it.
 *
 * Fixed-domain connectors (Colony, Molt Market, OpenTask, Artifact Council)
 * are NOT run through this guard for their normal traffic — their base URL
 * is hardcoded in source, not attacker-controlled. They only need this if a
 * feature starts following a URL found INSIDE untrusted response data.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

// Well-known cloud metadata / link-local addresses attackers target.
const BLOCKED_LITERAL_IPS = new Set(["169.254.169.254", "100.100.100.200"]);

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Covers loopback, private, link-local, and reserved ranges (RFC 1918/5735/6890). */
function isPrivateOrReservedIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange("0.0.0.0", 8) ||
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) || // shared address space (CGN)
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) ||
    inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) ||
    inRange("224.0.0.0", 4) || // multicast
    n === 0xffffffff // 255.255.255.255
  );
}

function isPrivateOrReservedIPv6(ip) {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fe80:") || // link-local
    lower.startsWith("fc") ||
    lower.startsWith("fd") || // unique local
    lower.startsWith("::ffff:127.") ||
    lower.startsWith("::ffff:10.") ||
    lower.startsWith("::ffff:169.254.")
  );
}

/**
 * Detects decimal/hex/octal IP-literal obfuscation used to bypass naive
 * string-based hostname blocklists (e.g. "http://2130706433/" == 127.0.0.1,
 * "http://0x7f000001/" == 127.0.0.1, "http://017700000001/" == 127.0.0.1).
 */
function decodeObfuscatedIPv4(hostname) {
  if (/^\d+$/.test(hostname)) {
    const n = Number(hostname);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
  }
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
  }
  return null;
}

function isBlockedHostnameLiteral(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_LITERAL_IPS.has(h)) return true;
  if (isPrivateOrReservedIPv4(h)) return true;
  if (h.includes(":") && isPrivateOrReservedIPv6(h)) return true;
  const decoded = decodeObfuscatedIPv4(h);
  if (decoded && isPrivateOrReservedIPv4(decoded)) return true;
  return false;
}

/**
 * Validates a URL is safe to fetch: http(s) only, no obfuscated/literal
 * private-network IP, and — for real network use — re-checks the actual
 * resolved IP (defends against DNS rebinding: a hostname that resolves to
 * a public IP at check-time but a private one at request-time would still
 * be caught here only at THIS resolution; callers making repeated requests
 * to a long-lived target should re-validate periodically).
 *
 * @param {string} urlString
 * @param {{ allowPrivate?: boolean, resolver?: (hostname: string) => Promise<string[]> }} [options]
 */
async function assertSafeUrl(urlString, { allowPrivate = false, resolver } = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Refusing to fetch: "${urlString}" is not a valid URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Refusing to fetch: unsupported protocol "${parsed.protocol}". Only http/https are allowed.`);
  }

  if (allowPrivate) return parsed;

  if (isBlockedHostnameLiteral(parsed.hostname)) {
    throw new Error(`Refusing to fetch "${urlString}": resolves to a private/internal/reserved address.`);
  }

  // Real DNS resolution check (DNS-rebinding defense) — pluggable resolver for tests.
  const lookup = resolver || (async (hostname) => (await dns.lookup(hostname, { all: true })).map((r) => r.address));
  let addresses;
  try {
    addresses = await lookup(parsed.hostname);
  } catch (err) {
    throw new Error(`Refusing to fetch "${urlString}": could not resolve hostname (${err.message}).`);
  }

  for (const addr of addresses) {
    if (isBlockedHostnameLiteral(addr)) {
      throw new Error(`Refusing to fetch "${urlString}": resolves to private/internal address ${addr}.`);
    }
  }

  return parsed;
}

module.exports = { assertSafeUrl, isBlockedHostnameLiteral, isPrivateOrReservedIPv4, decodeObfuscatedIPv4 };
