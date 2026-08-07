/**
 * Cloudflare Worker: audio-admin — manual entitlement management
 *
 * Three of the five ways people give (Zelle, Cash App, PayPal) can never tell a
 * website anything, so those partners are granted by hand here. This is also how
 * event comps are issued, how the pre-launch partner backfill is written, and how
 * anything the Zeffy sync gets wrong is corrected.
 *
 * Deliberately curl-only: no CORS, no browser UI. A web form would mean shipping
 * the admin secret to the browser.
 *
 *   curl -X POST https://audio-admin.alfanoministries.workers.dev/grant \
 *     -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
 *     -d '{"email":"someone@example.com","permanent":true,"note":"founding partner"}'
 *
 *   curl -X POST .../grant   -d '{"email":"x@y.com","days":365,"note":"Zelle, $100"}'
 *   curl -X POST .../revoke  -d '{"email":"x@y.com"}'
 *   curl ".../lookup?email=x@y.com" -H "Authorization: Bearer $ADMIN_SECRET"
 *   curl ".../list?limit=200"       -H "Authorization: Bearer $ADMIN_SECRET"
 *
 * SETUP (Cloudflare dashboard -> Workers -> Create "audio-admin", paste this):
 *   Settings -> Variables (encrypted):
 *     ADMIN_SECRET = a long random string (openssl rand -base64 48)
 *   Settings -> Bindings -> KV Namespace:
 *     AUDIO_ACCESS = the same namespace audio-access and audio-sync use
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e);

// Constant-time-ish comparison so the secret cannot be recovered by timing.
function secretMatches(given, expected) {
  const a = String(given || "");
  const b = String(expected || "");
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && secretMatches(m[1].trim(), env.ADMIN_SECRET);
}

async function readAccess(env, email) {
  const raw = await env.AUDIO_ACCESS.get(email);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function isEntitled(rec) {
  if (!rec) return false;
  if (rec.revoked) return false;
  if (rec.permanent) return true;
  const until = Date.parse(rec.accessUntil || "");
  return Number.isFinite(until) && until > Date.now();
}

/* ---------- handlers ---------- */

async function handleGrant(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ success: false, message: "Bad JSON" }, 400); }

  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ success: false, message: "Valid email required" }, 400);

  const permanent = body.permanent === true;
  const days = Number(body.days);
  if (!permanent && (!Number.isFinite(days) || days <= 0)) {
    return json({ success: false, message: "Pass permanent:true or a positive days value" }, 400);
  }

  const prev = await readAccess(env, email);
  const now = Date.now();

  // Extend from whichever is later: today, or the access they already hold.
  // Granting 30 days to someone with 60 left must not shorten their access.
  let accessUntil = prev?.accessUntil || null;
  if (!permanent) {
    const base = Math.max(now, Date.parse(prev?.accessUntil || "") || 0);
    accessUntil = new Date(base + days * 86400000).toISOString();
  }

  const rec = {
    ...(prev || {}),
    accessUntil,
    permanent: permanent || prev?.permanent === true,
    revoked: false,
    source: body.source || prev?.source || "manual",
    note: body.note != null ? String(body.note) : prev?.note || "",
    grantedAt: new Date(now).toISOString(),
  };

  await env.AUDIO_ACCESS.put(email, JSON.stringify(rec));
  return json({ success: true, email, record: rec, entitled: isEntitled(rec) });
}

async function handleRevoke(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ success: false, message: "Bad JSON" }, 400); }

  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ success: false, message: "Valid email required" }, 400);

  const prev = await readAccess(env, email);
  if (!prev) return json({ success: false, message: "No record for that email" }, 404);

  // Kept rather than deleted, so the giving history stays visible and a revoke
  // is not silently undone by the next Zeffy sync.
  const rec = { ...prev, revoked: true, permanent: false, revokedAt: new Date().toISOString() };
  await env.AUDIO_ACCESS.put(email, JSON.stringify(rec));
  return json({ success: true, email, record: rec, entitled: false });
}

async function handleLookup(url, env) {
  const email = normEmail(url.searchParams.get("email"));
  if (!validEmail(email)) return json({ success: false, message: "Valid email required" }, 400);
  const rec = await readAccess(env, email);
  return json({ success: true, email, found: !!rec, entitled: isEntitled(rec), record: rec });
}

async function handleList(url, env) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
  const out = [];
  let cursor;
  // Paginate until we have `limit` real records. The namespace is shared, so skip
  // the bookkeeping keys: `rl:` sign-in throttles and `p:` processed payment ids.
  while (out.length < limit) {
    const page = await env.AUDIO_ACCESS.list({ limit: 1000, cursor });
    for (const k of page.keys) {
      if (k.name.startsWith("rl:") || k.name.startsWith("p:")) continue;
      const rec = await readAccess(env, k.name);
      out.push({ email: k.name, entitled: isEntitled(rec), permanent: !!rec?.permanent,
                 accessUntil: rec?.accessUntil || null, source: rec?.source || null, note: rec?.note || "" });
      if (out.length >= limit) break;
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return json({ success: true, count: out.length, entitledCount: out.filter((r) => r.entitled).length, records: out });
}

export default {
  async fetch(request, env) {
    if (!env.ADMIN_SECRET) return json({ success: false, message: "ADMIN_SECRET not configured" }, 500);
    if (!authorized(request, env)) return json({ success: false, message: "Unauthorized" }, 401);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "POST" && path === "/grant") return handleGrant(request, env);
    if (request.method === "POST" && path === "/revoke") return handleRevoke(request, env);
    if (request.method === "GET" && path === "/lookup") return handleLookup(url, env);
    if (request.method === "GET" && path === "/list") return handleList(url, env);

    return json({ success: false, message: "Not found" }, 404);
  },
};
