/**
 * Cloudflare Worker: audio-sync — turn Zeffy giving into audio library access
 *
 * PRIMARY MECHANISM IS THE CRON, NOT THE WEBHOOK. A webhook that fails to
 * deliver silently costs a partner their access; a poll that fails is picked up
 * on the next run. The webhook is only here to make grants feel instant.
 *
 *   scheduled()          daily -> GET /api/v1/payments for the last 48 hours
 *   POST /zeffy-hook     Zeffy "payment.completed" -> grant that one immediately
 *   POST /backfill       one-time: walk all history, grandfather every recurring
 *                        donor as permanent (admin secret required)
 *
 * Grant rules, from the plan:
 *   recurring + active     -> access through recurring.current_period_end + 5 days
 *   recurring + not active -> leave alone; it lapses on its own
 *   one-time  $5 to $24    -> 35 days      $25 to $99 -> 90 days     $100+ -> 365 days
 *   refunded               -> no grant, and revoke if already granted
 *
 * IDEMPOTENCY: the cron looks back 48h but runs every 24h, so every payment is
 * seen at least twice. Day-based grants would stack on a re-read and hand out
 * double access, so each payment id is recorded in KV before it is applied.
 *
 * SETUP (Cloudflare dashboard -> Workers -> Create "audio-sync", paste this):
 *   Settings -> Variables (encrypt all):
 *     ZEFFY_API_KEY = from Zeffy Settings -> Integrations -> quick setup
 *     GHL_API_KEY   = the same GHL token the other workers use
 *     ADMIN_SECRET  = same value as audio-admin (guards /backfill)
 *     ZEFFY_HOOK_SECRET = a random string; append it to the webhook URL Zeffy calls
 *   Settings -> Bindings -> KV Namespace:
 *     AUDIO_ACCESS = the same namespace audio-access and audio-admin use
 *   Settings -> Triggers -> Cron: 0 9 * * *   (daily, 9am UTC)
 */

const ZEFFY_API = "https://api.zeffy.com/api/v1";
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_LOCATION_ID = "AIPTqymDwrSMF9zx8Pul";
const PARTNER_TAG = "audio partner";

const LOOKBACK_HOURS = 48;
const RECURRING_GRACE_DAYS = 5;
const SEEN_TTL_SEC = 90 * 86400;   // remember processed payments for 90 days

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e);
const DAY = 86400000;

function secretMatches(given, expected) {
  const a = String(given || ""), b = String(expected || "");
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- grant rules ---------- */

/**
 * Decide what a single payment earns. Returns one of:
 *   { until: ISO }  absolute expiry (recurring; naturally idempotent)
 *   { days: n }     relative extension (one-time; needs the seen-guard)
 *   { revoke: true} refunded
 *   null            nothing to do
 */
function grantFor(payment) {
  if (payment.refund_status && payment.refund_status !== "none") return { revoke: true };
  if (payment.status && payment.status !== "succeeded") return null;

  const rec = payment.recurring;
  if (rec && rec.is_recurring) {
    if (rec.status !== "active") return null;              // cancelled or paused: let it lapse
    if (rec.current_period_end) {
      // Zeffy sends unix seconds, like Stripe. Grace absorbs a late retry so
      // nobody is locked out on their own billing day.
      return { until: new Date(rec.current_period_end * 1000 + RECURRING_GRACE_DAYS * DAY).toISOString() };
    }
    return { days: 35 };                                    // active but no period end given
  }

  // amount is in the currency's minor unit (cents). CAD is treated at par with USD.
  const value = Number(payment.amount || 0) / 100;
  if (value >= 100) return { days: 365 };
  if (value >= 25) return { days: 90 };
  if (value >= 5) return { days: 35 };
  return null;                                              // under $5 buys goodwill, not access
}

/* ---------- entitlement store ---------- */

async function readAccess(env, email) {
  const raw = await env.AUDIO_ACCESS.get(email);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function applyGrant(env, email, grant, payment) {
  const prev = await readAccess(env, email);
  const now = Date.now();

  if (grant.revoke) {
    if (!prev) return "refund-no-record";
    await env.AUDIO_ACCESS.put(email, JSON.stringify({
      ...prev, revoked: true, permanent: false, revokedAt: new Date(now).toISOString(),
      note: `refunded payment ${payment.id}`,
    }));
    return "revoked";
  }

  // A hand-set permanent grant outranks anything Zeffy reports. Same for a
  // manual revoke: the sync must not quietly undo Marc's decision.
  if (prev && prev.permanent) return "already-permanent";
  if (prev && prev.revoked) return "manually-revoked";

  const held = Date.parse(prev?.accessUntil || "") || 0;
  let accessUntil;
  if (grant.until) {
    accessUntil = new Date(Math.max(held, Date.parse(grant.until))).toISOString();
  } else {
    accessUntil = new Date(Math.max(now, held) + grant.days * DAY).toISOString();
  }

  await env.AUDIO_ACCESS.put(email, JSON.stringify({
    ...(prev || {}),
    accessUntil,
    permanent: false,
    revoked: false,
    source: "zeffy",
    subscriptionId: payment.recurring?.subscription_id || prev?.subscriptionId || null,
    lastPaymentAt: payment.created ? new Date(payment.created * 1000).toISOString() : new Date(now).toISOString(),
    lastAmount: Number(payment.amount || 0),
    lastCurrency: payment.currency || "usd",
    syncedAt: new Date(now).toISOString(),
  }));
  return "granted";
}

/* ---------- GoHighLevel ---------- */

async function tagContact(env, payment, email) {
  if (!env.GHL_API_KEY) return false;
  const buyer = payment.buyer || {};
  const payload = {
    locationId: GHL_LOCATION_ID,
    email,
    source: "Audio library partner",
    tags: [PARTNER_TAG],
  };
  if (buyer.first_name) payload.firstName = buyer.first_name;
  if (buyer.last_name) payload.lastName = buyer.last_name;

  try {
    const r = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GHL_API_KEY}`, Version: "2021-07-28", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error("GHL upsert failed:", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error("GHL error:", String(e).slice(0, 200)); return false; }
}

/* ---------- Zeffy ---------- */

async function fetchPayments(env, params) {
  const qs = new URLSearchParams({ status: "succeeded", limit: "100", ...params });
  const r = await fetch(`${ZEFFY_API}/payments?${qs}`, {
    headers: { Authorization: `Bearer ${env.ZEFFY_API_KEY}` },
  });
  if (!r.ok) throw new Error(`Zeffy ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/* ---------- processing ---------- */

async function processOne(env, payment, opts = {}) {
  const email = normEmail(payment.buyer?.email);
  if (!validEmail(email)) return { id: payment.id, result: "no-email" };

  const grant = grantFor(payment);
  if (!grant) return { id: payment.id, email, result: "no-grant" };

  // Absolute (recurring) grants are idempotent by construction; day-based ones
  // are not, so they must never be applied twice for the same payment.
  if (grant.days && !opts.skipSeenGuard) {
    const seenKey = `p:${payment.id}`;
    if (await env.AUDIO_ACCESS.get(seenKey)) return { id: payment.id, email, result: "already-processed" };
    await env.AUDIO_ACCESS.put(seenKey, "1", { expirationTtl: SEEN_TTL_SEC });
  }

  const result = await applyGrant(env, email, grant, payment);
  if (result === "granted") await tagContact(env, payment, email);
  return { id: payment.id, email, result, grant };
}

async function syncSince(env, sinceUnix) {
  const summary = { scanned: 0, granted: 0, revoked: 0, skipped: 0, errors: [] };
  let cursor;

  for (let page = 0; page < 50; page++) {   // hard stop; 50 pages = 5,000 payments
    let data;
    try {
      data = await fetchPayments(env, cursor
        ? { "created[gte]": String(sinceUnix), starting_after: cursor }
        : { "created[gte]": String(sinceUnix) });
    } catch (e) { summary.errors.push(String(e).slice(0, 200)); break; }

    for (const p of data.data || []) {
      summary.scanned++;
      try {
        const r = await processOne(env, p);
        if (r.result === "granted") summary.granted++;
        else if (r.result === "revoked") summary.revoked++;
        else summary.skipped++;
      } catch (e) { summary.errors.push(`${p.id}: ${String(e).slice(0, 120)}`); }
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return summary;
}

/* ---------- backfill ---------- */

// One-time: every donor who has ever given recurringly becomes a permanent
// partner, grandfathered in before the gate went live.
async function backfill(env, sinceUnix) {
  const summary = { scanned: 0, recurringDonors: 0, granted: 0, errors: [] };
  const seen = new Set();
  let cursor;

  for (let page = 0; page < 100; page++) {
    let data;
    try {
      data = await fetchPayments(env, cursor
        ? { "created[gte]": String(sinceUnix), starting_after: cursor }
        : { "created[gte]": String(sinceUnix) });
    } catch (e) { summary.errors.push(String(e).slice(0, 200)); break; }

    for (const p of data.data || []) {
      summary.scanned++;
      if (!p.recurring?.is_recurring) continue;
      const email = normEmail(p.buyer?.email);
      if (!validEmail(email) || seen.has(email)) continue;
      seen.add(email);
      summary.recurringDonors++;

      try {
        const prev = await readAccess(env, email);
        if (prev?.revoked) continue;                 // never resurrect a manual revoke
        await env.AUDIO_ACCESS.put(email, JSON.stringify({
          ...(prev || {}),
          permanent: true,
          revoked: false,
          accessUntil: prev?.accessUntil || null,
          source: "zeffy-backfill",
          subscriptionId: p.recurring?.subscription_id || null,
          note: "Grandfathered: partnering before the audio library launched.",
          grantedAt: new Date().toISOString(),
        }));
        summary.granted++;
        await tagContact(env, p, email);
      } catch (e) { summary.errors.push(`${email}: ${String(e).slice(0, 120)}`); }
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return summary;
}

/* ---------- entry points ---------- */

export default {
  // Daily cron. This is the source of truth.
  async scheduled(event, env, ctx) {
    const since = Math.floor((Date.now() - LOOKBACK_HOURS * 3600 * 1000) / 1000);
    ctx.waitUntil(
      syncSince(env, since).then((s) => console.log("audio-sync:", JSON.stringify(s)))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    // Zeffy webhook. Authenticated by a secret in the query string, since Zeffy
    // does not sign its payloads. Failure here is non-fatal: the cron catches it.
    if (request.method === "POST" && path === "/zeffy-hook") {
      if (!secretMatches(url.searchParams.get("s"), env.ZEFFY_HOOK_SECRET)) {
        return json({ success: false, message: "Unauthorized" }, 401);
      }
      let body;
      try { body = await request.json(); } catch { return json({ received: true, note: "unparseable" }, 200); }

      const payment = body?.data || body?.payment || body;
      try {
        const r = await processOne(env, payment);
        return json({ received: true, ...r }, 200);      // always 2xx so Zeffy stops retrying
      } catch (e) {
        console.error("hook error:", String(e).slice(0, 200));
        return json({ received: true, note: "deferred to cron" }, 200);
      }
    }

    // Manual runs, both admin-only.
    const auth = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!auth || !secretMatches(auth[1].trim(), env.ADMIN_SECRET)) {
      return json({ success: false, message: "Unauthorized" }, 401);
    }

    if (path === "/sync") {
      const hours = Number(url.searchParams.get("hours")) || LOOKBACK_HOURS;
      const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
      return json({ success: true, hours, summary: await syncSince(env, since) });
    }

    if (path === "/backfill") {
      // Default reaches back to 2020; override with ?since=<unix>.
      const since = Number(url.searchParams.get("since")) || 1577836800;
      if (url.searchParams.get("confirm") !== "yes") {
        return json({ success: false, message: "Add &confirm=yes to run the backfill." }, 400);
      }
      return json({ success: true, summary: await backfill(env, since) });
    }

    return json({ success: false, message: "Not found" }, 404);
  },
};
