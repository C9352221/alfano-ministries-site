/**
 * Cloudflare Worker: book-ledger — the sales book for the Book Table POS
 *
 * Until this existed, every sale lived in one phone's browser storage and
 * nowhere else: clear the browsing data, lose the phone, or let iOS evict a
 * non-installed site after a week, and the event was gone. This worker is the
 * copy that survives, and it is also what lets two phones sell at one table
 * and see a single running total and one shared stock count.
 *
 * The phone stays the source of truth while selling. It writes locally first
 * and syncs in the background, so a church basement with no signal never
 * blocks a sale -- the queue drains when signal comes back.
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD: buyer names, emails, or phone numbers.
 * This is a money log; GHL is the CRM. `email` is stripped on the way in even
 * if a client sends it, so a leaked admin secret exposes how many books Marc
 * sold and nothing about who bought them.
 *
 * ON THE WRITE KEY: sell.html is a public page and its source is readable, so
 * LEDGER_WRITE_KEY is a spam filter, not a secret. What someone who lifts it
 * can do: append junk sale rows under their own device id. What they cannot
 * do: read any row, alter Marc's rows, or reach Stripe, GHL, or Resend.
 * Reading and exporting need LEDGER_ADMIN_SECRET, which never ships to a
 * browser. If junk ever shows up, the fix is Turnstile or per-device
 * enrolment; until then this is the honest trade for an offline-first POS.
 *
 *   curl ".../export.csv" -H "Authorization: Bearer $ADMIN_SECRET" -o sales.csv
 *   curl ".../devices"    -H "Authorization: Bearer $ADMIN_SECRET"
 *
 * SETUP (Cloudflare dashboard -> Workers -> Create "book-ledger", paste this):
 *   Settings -> Variables and Secrets (encrypt both):
 *     LEDGER_WRITE_KEY   = long random string; ALSO goes in sell.html CONFIG
 *     LEDGER_ADMIN_SECRET = a DIFFERENT long random string; never in the app
 *   Settings -> Bindings -> KV Namespace:
 *     BOOK_LEDGER = a namespace of the same name
 */

const ALLOWED_ORIGINS = [
  "https://alfanoministries.com",
  "https://www.alfanoministries.com",
  "http://localhost",
  "http://127.0.0.1",
];

// One key per device per event holds that device's rows. Only that device ever
// writes its own feed, so there is no cross-device conflict to resolve, and a
// pull is one list plus one read per other phone rather than one read per sale.
const feedKey = (event, device) => `feed:${event}:${device}`;
const stockKey = (event) => `stock:${event}`;
const devKey = (device) => `dev:${device}`;

const MAX_SALES_PER_POST = 50;
const MAX_ITEMS_PER_SALE = 40;
const MAX_BODY_BYTES = 96 * 1024;
const MAX_ROWS_PER_FEED = 2000;
const RATE_PER_MIN = 120;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
const json = (body, status = 200, origin = ALLOWED_ORIGINS[0]) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });

// Constant-time-ish comparison so a secret cannot be recovered by timing.
function secretMatches(given, expected) {
  const a = String(given || "");
  const b = String(expected || "");
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function adminOk(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return !!m && secretMatches(m[1].trim(), env.LEDGER_ADMIN_SECRET);
}

const clean = (v, max = 120) => String(v == null ? "" : v).slice(0, max);
const slug = (v, max = 80) => clean(v, max).replace(/[^A-Za-z0-9._:-]/g, "");
const num = (v) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);

async function readJSON(env, key) {
  const raw = await env.BOOK_LEDGER.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** A minute-bucketed counter, so a stolen write key cannot run up the bill. */
async function rateLimited(env, ip) {
  const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const n = parseInt((await env.BOOK_LEDGER.get(key)) || "0", 10) + 1;
  await env.BOOK_LEDGER.put(key, String(n), { expirationTtl: 120 });
  return n > RATE_PER_MIN;
}

/**
 * Normalise one sale row. Anything not named here is dropped, which is how the
 * buyer's email stays out of the ledger even if a future client forgets.
 */
function sanitizeRow(r) {
  if (!r || typeof r !== "object") return null;
  const id = slug(r.id, 64);
  if (!id) return null;

  const ts = Date.parse(r.ts);
  if (!isFinite(ts)) return null;
  const age = Date.now() - ts;
  if (age > 30 * 86400000 || age < -86400000) return null;   // stale or clock-skewed into the future

  const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ITEMS_PER_SALE).map((i) => ({
    id: slug(i && i.id, 48),
    title: clean(i && i.title, 120),
    format: clean(i && i.format, 40),
    qty: Math.max(0, Math.min(999, Math.round(num(i && i.qty)))),
    unit: num(i && i.unit),
    unitUSD: i && i.unitUSD == null ? null : num(i && i.unitUSD),
  }));

  return {
    id,
    rev: Math.max(1, Math.round(num(r.rev)) || 1),
    ts: new Date(ts).toISOString(),
    date: slug(r.date, 10),
    event: slug(r.event, 80) || slug(r.date, 10),
    cur: slug(r.cur, 8).toUpperCase(),
    amt: num(r.amt),
    amtUSD: r.amtUSD == null ? null : num(r.amtUSD),
    method: slug(r.method, 16),
    books: Math.max(0, Math.round(num(r.books))),
    gift: num(r.gift),
    items,
    orderId: clean(r.orderId, 40),
    stripeSessionId: clean(r.stripeSessionId, 80),
    receipt: slug(r.receipt, 16),
    recovered: !!r.recovered,
    void: !!r.void,
    // email / phone / name are intentionally absent -- see the header.
  };
}

/* ============================ POST /sync ============================ */
async function handleSync(request, env, origin) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, message: "Too big" }, 413, origin);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, message: "Bad request" }, 400, origin); }

  if (!env.LEDGER_WRITE_KEY) return json({ ok: false, message: "LEDGER_WRITE_KEY not configured" }, 500, origin);
  if (!secretMatches(body.key, env.LEDGER_WRITE_KEY)) return json({ ok: false, message: "Unauthorized" }, 401, origin);

  const device = slug(body.deviceId, 40);
  if (!device) return json({ ok: false, message: "No device id" }, 400, origin);

  const ip = request.headers.get("CF-Connecting-IP") || "0";
  if (await rateLimited(env, ip)) return json({ ok: false, message: "Slow down" }, 429, origin);

  const incoming = (Array.isArray(body.sales) ? body.sales : []).slice(0, MAX_SALES_PER_POST);
  const accepted = [], rejected = [];
  const byEvent = {};

  for (const r of incoming) {
    const row = sanitizeRow(r);
    if (!row) { rejected.push({ id: (r && r.id) || "?", reason: "bad row" }); continue; }
    (byEvent[row.event] = byEvent[row.event] || []).push(row);
  }

  // Merge into this device's feed, newest rev wins. Re-sending a row that is
  // already stored is a no-op that still reports `accepted`, so a client whose
  // acknowledgement got lost stops retrying instead of writing a duplicate.
  for (const event of Object.keys(byEvent)) {
    const key = feedKey(event, device);
    const feed = (await readJSON(env, key)) || { device, event, rows: [] };
    const index = {};
    feed.rows.forEach((row, i) => { index[row.id] = i; });

    let dirty = false;
    for (const row of byEvent[event]) {
      const at = index[row.id];
      if (at == null) {
        feed.rows.push(row); index[row.id] = feed.rows.length - 1; dirty = true;
      } else if (row.rev > (feed.rows[at].rev || 1)) {
        feed.rows[at] = row; dirty = true;                     // an edit: receipt emailed, or voided
      }
      accepted.push(row.id);
    }
    if (dirty) {
      if (feed.rows.length > MAX_ROWS_PER_FEED) feed.rows = feed.rows.slice(-MAX_ROWS_PER_FEED);
      feed.label = clean(body.label, 40) || feed.label || "";
      feed.updated = new Date().toISOString();
      await env.BOOK_LEDGER.put(key, JSON.stringify(feed));
    }
  }

  // Stock counts for the event, shared by both phones. Last write wins on rev;
  // edits are rare and deliberate, so a lost race just means retyping a number.
  const eventId = slug(body.eventId, 80);
  let stock = eventId ? await readJSON(env, stockKey(eventId)) : null;
  if (eventId && body.stock && typeof body.stock === "object") {
    const incomingRev = Math.round(num(body.stock.rev));
    if (!stock || incomingRev > (stock.rev || 0)) {
      const counts = {};
      const src = body.stock.counts || {};
      Object.keys(src).slice(0, 200).forEach((k) => {
        const packed = Math.max(0, Math.min(9999, Math.round(num(src[k] && src[k].packed))));
        counts[slug(k, 80)] = { packed };
      });
      stock = { rev: incomingRev, updated: new Date().toISOString(), by: device, counts };
      await env.BOOK_LEDGER.put(stockKey(eventId), JSON.stringify(stock));
    }
  }

  const dev = (await readJSON(env, devKey(device))) || { firstSeen: new Date().toISOString(), sales: 0 };
  dev.label = clean(body.label, 40) || dev.label || "";
  dev.lastSeen = new Date().toISOString();
  dev.lastEvent = eventId || dev.lastEvent || "";
  dev.sales = (dev.sales || 0) + accepted.length;
  await env.BOOK_LEDGER.put(devKey(device), JSON.stringify(dev));

  return json({ ok: true, accepted, rejected, stock: stock || null }, 200, origin);
}

/* ============================ GET /event ============================
   What the OTHER phone sold, plus the shared stock count. This is the whole
   of "two phones, one table": each device pulls the others' rows and adds
   them to its own for the running total and for counting stock down. */
async function handleEvent(url, env, origin) {
  if (!secretMatches(url.searchParams.get("key"), env.LEDGER_WRITE_KEY))
    return json({ ok: false, message: "Unauthorized" }, 401, origin);

  const event = slug(url.searchParams.get("id"), 80);
  if (!event) return json({ ok: false, message: "No event" }, 400, origin);
  const self = slug(url.searchParams.get("device"), 40);

  const list = await env.BOOK_LEDGER.list({ prefix: `feed:${event}:` });
  const rows = [], devices = [];
  for (const k of list.keys) {
    const device = k.name.slice(`feed:${event}:`.length);
    if (device === self) continue;
    const feed = await readJSON(env, k.name);
    if (!feed) continue;
    devices.push({ device, label: feed.label || "", updated: feed.updated || null, count: (feed.rows || []).length });
    (feed.rows || []).forEach((r) => rows.push({ ...r, device, deviceLabel: feed.label || "" }));
  }
  const stock = await readJSON(env, stockKey(event));
  return json({ ok: true, event, rows, devices, stock: stock || null }, 200, origin);
}

/* ============================ admin ============================ */
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function allFeeds(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.BOOK_LEDGER.list({ prefix: "feed:", cursor, limit: 1000 });
    for (const k of page.keys) {
      const feed = await readJSON(env, k.name);
      if (feed) out.push(feed);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function handleExport(url, env) {
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const shape = url.searchParams.get("shape") === "sales" ? "sales" : "lines";

  const head = shape === "sales"
    ? ["sale_id", "device", "ts_utc", "local_date", "event", "method", "currency", "total_cur", "total_usd", "gift_cur", "books", "voided", "receipt", "order_id"]
    : ["sale_id", "device", "ts_utc", "local_date", "event", "method", "currency", "sale_total_cur", "sale_total_usd", "gift_cur",
       "item_id", "item_title", "item_format", "item_qty", "item_unit_cur", "item_unit_usd", "voided", "receipt", "order_id"];
  const lines = [head.join(",")];

  for (const feed of await allFeeds(env)) {
    const who = feed.label || feed.device || "";
    for (const r of feed.rows || []) {
      if (from && r.date < from) continue;
      if (to && r.date > to) continue;
      const base = [r.id, who, r.ts, r.date, r.event, r.method, r.cur, r.amt, r.amtUSD == null ? "" : r.amtUSD, r.gift || 0];
      const tail = [r.void ? "yes" : "", r.receipt || "", r.orderId || ""];
      if (shape === "sales") {
        lines.push(base.concat([r.books || 0]).concat(tail).map(csvCell).join(","));
      } else if (r.items && r.items.length) {
        for (const i of r.items) {
          lines.push(base.concat([i.id, i.title, i.format || "", i.qty, i.unit, i.unitUSD == null ? "" : i.unitUSD])
            .concat(tail).map(csvCell).join(","));
        }
      } else {
        lines.push(base.concat(["", "", "", r.books || "", "", ""]).concat(tail).map(csvCell).join(","));
      }
    }
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="book-table-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

async function handleDevices(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.BOOK_LEDGER.list({ prefix: "dev:", cursor, limit: 1000 });
    for (const k of page.keys) {
      const d = await readJSON(env, k.name);
      if (d) out.push({ device: k.name.slice(4), ...d });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return json({ ok: true, devices: out });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const ok = ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
    const safe = ok ? origin : ALLOWED_ORIGINS[0];
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(safe) });

    // Admin routes are curl-only: no CORS, no browser UI, so the admin secret
    // never has a reason to exist inside a web page.
    if (request.method === "GET" && (path === "/export.csv" || path === "/devices")) {
      if (!adminOk(request, env)) return json({ ok: false, message: "Unauthorized" }, 401);
      return path === "/devices" ? handleDevices(env) : handleExport(url, env);
    }

    if (!ok) return json({ ok: false, message: "Forbidden" }, 403, safe);
    if (request.method === "POST" && (path === "/sync" || path === "/")) return handleSync(request, env, safe);
    if (request.method === "GET" && path === "/event") return handleEvent(url, env, safe);

    return json({ ok: false, message: "Not found" }, 404, safe);
  },
};
