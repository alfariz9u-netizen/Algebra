"use strict";

const dns = require("node:dns").promises;
const net = require("node:net");

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

/** Expands any textual IPv6 (incl. "::" and an embedded dotted IPv4 tail) into 8 16-bit groups, or null. */
function parseIPv6(input) {
  let ip = String(input).toLowerCase().split("%")[0]; // drop a zone id (fe80::1%eth0)
  if (!net.isIPv6(ip)) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (tail) {
    const n = ipv4ToInt(tail[1]);
    if (n === null) return null;
    ip = ip.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill("0") : []), ...rest].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi, lo) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");

/** Loopback, unspecified, link-local, unique-local, multicast, documentation — and any IPv4 embedded in mapped/NAT64/6to4/compat forms. */
function isPrivateOrReservedIPv6(ip) {
  const g = parseIPv6(ip);
  if (!g) return true; // unparseable literal: fail closed
  const allZeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (allZeroUpTo(5) && g[5] === 0xffff) return isPrivateOrReservedIPv4(v4FromGroups(g[6], g[7])); // ::ffff:a.b.c.d
  if (allZeroUpTo(6)) return isPrivateOrReservedIPv4(v4FromGroups(g[6], g[7])); // ::a.b.c.d (deprecated compat)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateOrReservedIPv4(v4FromGroups(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateOrReservedIPv4(v4FromGroups(g[1], g[2])); // 6to4
  return false;
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
  // URL.hostname keeps IPv6 literals in brackets ("[::1]"), which no IP check ever matched.
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (/\.(localhost|local|internal|localdomain|home\.arpa)$/.test(h)) return true;
  if (BLOCKED_LITERAL_IPS.has(h)) return true;
  if (isPrivateOrReservedIPv4(h)) return true;
  if (h.includes(":")) return isPrivateOrReservedIPv6(h);
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

/**
 * fetch() with SSRF protection on EVERY hop: redirects are followed manually and each Location is
 * re-validated (a public URL that 302s to http://169.254.169.254/ is refused), plus a timeout and a
 * response-size cap. Returns { response, text } — the body is read here so the cap is enforced.
 *
 * Note: Node's fetch cannot pin the validated IP, so a DNS-rebinding race between check and connect
 * remains theoretically possible; each hop is re-resolved, which narrows (not eliminates) it.
 */
async function safeFetch(url, init = {}, { maxRedirects = 3, timeoutMs = 15000, maxBytes = 1024 * 1024, resolver, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let current = url;
  let method = init.method || "GET";
  let body = init.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current, { resolver });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(current, { ...init, method, body, redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers && response.headers.get && response.headers.get("location");
        if (!location) throw new Error(`Redirect without Location from ${current}`);
        current = new URL(location, current).toString();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const declared = Number(response.headers && response.headers.get && response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response too large (${declared} > ${maxBytes} bytes).`);
      const text = await readCapped(response, maxBytes);
      return { response, text };
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`Request to ${current} timed out after ${timeoutMs}ms.`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Too many redirects (> ${maxRedirects}) starting at ${url}.`);
}

async function readCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const t = await response.text();
    if (t.length > maxBytes) throw new Error(`Response too large (> ${maxBytes} bytes).`);
    return t;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error(`Response too large (> ${maxBytes} bytes).`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = { assertSafeUrl, safeFetch, isBlockedHostnameLiteral, isPrivateOrReservedIPv4, isPrivateOrReservedIPv6, decodeObfuscatedIPv4 };
