"use strict";
/**
 * In-process fake of the slice of Supabase's PostgREST API the agent's state
 * layer uses: GET/POST(upsert)/PATCH/DELETE on /rest/v1/<table> with
 * eq./in. filters, order/limit/offset, on_conflict + Prefer resolution, the
 * unique indexes from supabase/migrations/001_state_tables.sql, and the
 * economic_prune RPC. `setFailing(true)` makes every request answer 503.
 */
const http = require("node:http");

const PKS = { economic_events: "id", economic_rollup: "id", approvals: "id", learning_state: "key", moltbook_state: "key" };

function startFakeSupabase({ key = "test-service-key" } = {}) {
  const tables = Object.fromEntries(Object.keys(PKS).map((t) => [t, new Map()]));
  const requests = [];
  let failing = false;

  const matches = (row, filters) =>
    filters.every(([col, op, val]) => {
      const cell = row[col] === undefined || row[col] === null ? null : String(row[col]);
      if (op === "eq") return cell === val;
      if (op === "in") return val.split(",").includes(cell);
      return true;
    });

  const parseFilters = (params) => {
    const out = [];
    for (const [col, raw] of params) {
      if (["select", "order", "limit", "offset", "on_conflict"].includes(col)) continue;
      const dot = raw.indexOf(".");
      out.push([col, raw.slice(0, dot), raw.slice(dot + 1).replace(/^\((.*)\)$/, "$1")]);
    }
    return out;
  };

  const uniqueViolation = (table, row, ignoreId) => {
    if (table !== "economic_events") return false;
    for (const other of tables.economic_events.values()) {
      if (other.id === ignoreId) continue;
      if (row.tx_signature && other.tx_signature === row.tx_signature) return true;
      if (["task_completed", "task_failed", "payment_received"].includes(row.type) && row.task_id && other.type === row.type && other.task_id === row.task_id) return true;
    }
    return false;
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const url = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: url.pathname, query: url.search, body, headers: req.headers });
      if (failing) return send(503, { message: "fake outage" });
      if (req.headers.apikey !== key || req.headers.authorization !== `Bearer ${key}`) return send(401, { message: "Invalid API key" });

      const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if (rpc) {
        if (rpc[1] !== "economic_prune") return send(404, { message: "no such function" });
        for (const id of body.p_ids || []) tables.economic_events.delete(id);
        tables.economic_rollup.set(1, { id: 1, data: body.p_rollup, updated_at: new Date().toISOString() });
        return send(204);
      }

      const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
      if (!m || !tables[m[1]]) return send(404, { message: "relation does not exist" });
      const table = m[1];
      const pk = PKS[table];
      const store = tables[table];
      const prefer = String(req.headers.prefer || "");
      const wantRows = prefer.includes("return=representation");

      if (req.method === "GET") {
        let rows = [...store.values()].filter((r) => matches(r, parseFilters(url.searchParams)));
        const order = url.searchParams.get("order");
        if (order) {
          const keys = order.split(",").map((o) => o.split("."));
          rows.sort((a, b) => {
            for (const [col, dir] of keys) {
              if (a[col] < b[col]) return dir === "desc" ? 1 : -1;
              if (a[col] > b[col]) return dir === "desc" ? -1 : 1;
            }
            return 0;
          });
        }
        const offset = Number(url.searchParams.get("offset") || 0);
        const limit = Number(url.searchParams.get("limit") || rows.length);
        return send(200, rows.slice(offset, offset + limit));
      }

      if (req.method === "POST") {
        const list = Array.isArray(body) ? body : [body];
        const ignore = prefer.includes("ignore-duplicates");
        // PostgREST is atomic: check everything first.
        for (const row of list) {
          const exists = store.has(row[pk]);
          if (exists && !ignore && !prefer.includes("merge-duplicates")) return send(409, { code: "23505", message: "duplicate key" });
          if (!exists && uniqueViolation(table, row, row.id)) return send(409, { code: "23505", message: "duplicate key value violates unique constraint" });
        }
        for (const row of list) {
          if (store.has(row[pk])) {
            if (!ignore) store.set(row[pk], { ...store.get(row[pk]), ...row });
          } else store.set(row[pk], { ...row });
        }
        return send(201, wantRows ? list : undefined);
      }

      if (req.method === "PATCH") {
        const hit = [...store.values()].filter((r) => matches(r, parseFilters(url.searchParams)));
        for (const r of hit) store.set(r[pk], Object.assign(r, body));
        return send(200, wantRows ? hit : undefined);
      }

      if (req.method === "DELETE") {
        for (const r of [...store.values()].filter((x) => matches(x, parseFilters(url.searchParams)))) store.delete(r[pk]);
        return send(204);
      }
      return send(405, { message: "method not allowed" });
    });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        key,
        tables,
        requests,
        setFailing: (v) => {
          failing = Boolean(v);
        },
        close: () => new Promise((r) => server.close(r)),
      })
    )
  );
}

module.exports = { startFakeSupabase };
