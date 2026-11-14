"use strict";

/**
 * Minimal PostgREST client + write-behind queue used to keep this agent's
 * operational state (economic events, approvals, learning state, moltbook
 * post state) in Supabase, so it survives Render's ephemeral disk.
 *
 * DESIGN (why it looks like this):
 *   - Every store (EconomicIntelligence, ApprovalQueue, LearningEngine, the
 *     moltbook post state) has a SYNCHRONOUS public API that many callers
 *     depend on. Supabase is async. So each store keeps its in-memory state
 *     (the cache), writes it to the local persistDir file exactly as before
 *     (the FALLBACK), and mirrors every change to Supabase through a
 *     WriteBehindQueue. At startup `init()` pulls Supabase state into memory.
 *   - Supabase being down, mis-configured, or missing a table must never
 *     crash the agent: every remote failure is caught, logged, and the local
 *     copy keeps working. A queue that saw a failure re-pushes local state
 *     later (reconcile) so nothing recorded during the outage is lost.
 *   - Configuration is the existing SUPABASE_URL / SUPABASE_SERVICE_KEY.
 *     Without them everything behaves exactly as before (local only).
 */

class SupabaseRequestError extends Error {
  constructor(message, { status = 0, body = null, network = false } = {}) {
    super(message);
    this.name = "SupabaseRequestError";
    this.status = status;
    this.body = body;
    this.network = network;
  }
}

class SupabaseState {
  constructor({ url, key, timeoutMs } = {}) {
    this.url = String(url ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
    this.key = key ?? process.env.SUPABASE_SERVICE_KEY ?? "";
    const t = Number(timeoutMs ?? process.env.SUPABASE_STATE_TIMEOUT_MS ?? 8000);
    this.timeoutMs = Number.isFinite(t) && t > 0 ? t : 8000;
  }

  get enabled() {
    return Boolean(this.url && this.key);
  }

  async request(method, pathAndQuery, { body, headers } = {}) {
    if (!this.enabled) throw new SupabaseRequestError("Supabase not configured", { network: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.url}/rest/v1/${pathAndQuery}`, {
        method,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          ...(headers || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new SupabaseRequestError(`Supabase ${method} ${pathAndQuery.split("?")[0]} unreachable: ${err.message}`, { network: true });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new SupabaseRequestError(
        `Supabase ${method} ${pathAndQuery.split("?")[0]} failed: ${res.status} ${text.slice(0, 200)}`,
        { status: res.status, body: data }
      );
    }
    return data;
  }

  /** All rows matching `query` (a PostgREST query string, no leading "?"), paged. */
  async selectAll(table, query = "select=*", pageSize = 1000) {
    const out = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.request("GET", `${table}?${query}&limit=${pageSize}&offset=${offset}`);
      if (!Array.isArray(page)) break;
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }

  /** INSERT .. ON CONFLICT. mode: "merge" (upsert) or "ignore" (skip existing). */
  async upsert(table, rows, { onConflict = "id", mode = "merge" } = {}) {
    const list = Array.isArray(rows) ? rows : [rows];
    if (list.length === 0) return;
    await this.request("POST", `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      body: list,
      headers: { Prefer: `resolution=${mode === "ignore" ? "ignore" : "merge"}-duplicates,return=minimal` },
    });
  }

  /** PATCH rows matching `filter`; returns the updated rows (empty array = nothing matched). */
  async patch(table, filter, body) {
    const rows = await this.request("PATCH", `${table}?${filter}`, { body, headers: { Prefer: "return=representation" } });
    return Array.isArray(rows) ? rows : [];
  }

  async remove(table, filter) {
    await this.request("DELETE", `${table}?${filter}`, { headers: { Prefer: "return=minimal" } });
  }

  async rpc(fn, args) {
    return this.request("POST", `rpc/${fn}`, { body: args });
  }
}

/** PostgREST filter helpers. */
const eq = (col, val) => `${col}=eq.${encodeURIComponent(val)}`;

const isRetryable = (err) => Boolean(err && (err.network || err.status === 408 || err.status === 429 || err.status >= 500));

/**
 * Serial write-behind queue. Never rejects and never throws into callers.
 * After a failed op the owner is asked to `reconcile()` (re-push whatever the
 * local copy holds) once the remote is reachable again — checked on a timer.
 */
class WriteBehindQueue {
  constructor({ label, reconcile, retries = 2, retryDelayMs = 200, reconcileEveryMs } = {}) {
    this.label = label;
    this._reconcile = reconcile || null;
    this._retries = retries;
    this._retryDelayMs = retryDelayMs;
    this._tail = Promise.resolve();
    this.needsReconcile = false;
    this.failures = 0;
    this._timer = null;
    this._reconcileEveryMs = Number(reconcileEveryMs ?? process.env.SUPABASE_STATE_RECONCILE_MS ?? 60000);
  }

  /** Queue `fn`; resolves with its value, or undefined if it ultimately failed. */
  push(fn) {
    const run = async () => {
      let lastErr;
      for (let attempt = 0; attempt <= this._retries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (!isRetryable(err) || attempt === this._retries) break;
          await new Promise((r) => setTimeout(r, this._retryDelayMs * (attempt + 1)));
        }
      }
      this._failed(lastErr);
      return undefined;
    };
    const p = this._tail.then(run);
    this._tail = p.catch(() => {});
    return p;
  }

  /** For callers whose own (non-queued) remote call failed — same bookkeeping as a failed queued op. */
  noteFailure(err) {
    this._failed(err);
  }

  _failed(err) {
    this.failures += 1;
    this.needsReconcile = true;
    console.warn(`[state:${this.label}] Supabase write failed — local copy is kept and will be re-synced: ${err && err.message}`);
    this._armTimer();
  }

  _armTimer() {
    if (this._timer || !this._reconcile || !(this._reconcileEveryMs > 0)) return;
    this._timer = setInterval(() => {
      this.reconcileNow().catch(() => {});
    }, this._reconcileEveryMs);
    if (this._timer.unref) this._timer.unref();
  }

  async reconcileNow() {
    if (!this.needsReconcile || !this._reconcile) return false;
    try {
      await this._reconcile();
      this.needsReconcile = false;
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      return true;
    } catch (err) {
      console.warn(`[state:${this.label}] re-sync still failing: ${err.message}`);
      return false;
    }
  }

  /** Resolves once everything queued so far has been attempted. */
  async flush() {
    await this._tail;
  }
}

module.exports = { SupabaseState, SupabaseRequestError, WriteBehindQueue, eq, isRetryable };
