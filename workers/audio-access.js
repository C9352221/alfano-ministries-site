/**
 * Cloudflare Worker: audio-access — sign-in and unlock for the audiobook library
 *
 * The audiobooks are gated. The ElevenLabs project IDs live ONLY in this worker,
 * never in page source, so an un-entitled visitor has nothing to re-embed.
 *
 *   POST /request  { email }
 *     -> Always answers the same neutral response so nobody can probe the worker
 *        to learn who partners with the ministry. If the email IS entitled, a
 *        30-day sign-in link goes out via Resend.
 *
 *   POST /unlock   { token }
 *     -> Verifies the HMAC and expiry, then RE-READS the entitlement store, so a
 *        partner who has lapsed stops working even while holding a valid token.
 *        Returns the project IDs.
 *
 * SETUP (Cloudflare dashboard -> Workers -> Create "audio-access", paste this):
 *   Settings -> Variables (encrypt both):
 *     ACCESS_TOKEN_SECRET = a long random string (openssl rand -base64 48)
 *     RESEND_API_KEY      = the same Resend key used by book-sale
 *   Settings -> Bindings -> KV Namespace:
 *     AUDIO_ACCESS = the entitlement namespace (shared with audio-admin/audio-sync)
 */

const ALLOWED_ORIGINS = [
  "https://alfanoministries.com",
  "https://www.alfanoministries.com",
  "http://localhost",
  "http://127.0.0.1",
];

const SITE = "https://alfanoministries.com";
const RESEND_URL = "https://api.resend.com/emails";
const MAIL_FROM = "Alfano Ministries <receipts@alfanoministries.com>";
const MAIL_SUBJECT = "Your sign-in link for the audio library";

const TOKEN_TTL_DAYS = 30;
const REQUEST_THROTTLE_SEC = 60;   // one sign-in email per address per minute

// The gated payload. These IDs are the whole reason this worker exists.
const PUBLIC_USER_ID = "c993cfb55bc19fa7d9286169ac661d10ba170dde088026269bc53ffe7bd26e31";
const BOOKS = [
  { slug: "faith-to-build", title: "Faith to Build",  projectId: "3FqzynuG0YK3nJQgAgU9" },
  { slug: "go",             title: "GO",              projectId: "GLVqV2AEdN0lQScKmtHb" },
  { slug: "wiser-than-ai",  title: "Wiser Than AI",   projectId: "uYAoiD4HQXkeZVL4qNcI" },
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
const json = (body, status, origin) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });

const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e);

/* ---------- entitlement ---------- */

// Shared with audio-admin and audio-sync. A record looks like:
//   { accessUntil, permanent, source, subscriptionId, lastPaymentAt, lastAmount, note }
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

/* ---------- tokens ---------- */

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  const p = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function mintToken(email, secret) {
  const exp = Date.now() + TOKEN_TTL_DAYS * 86400000;
  const payload = `${email}|${exp}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

// Returns the email on success, or null on any failure. Never throws.
async function verifyToken(token, secret) {
  const [p, s] = String(token || "").split(".");
  if (!p || !s) return null;
  try {
    const payload = new TextDecoder().decode(unb64url(p));
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(s), enc.encode(payload));
    if (!ok) return null;
    const i = payload.lastIndexOf("|");
    if (i < 1) return null;
    const email = payload.slice(0, i);
    const exp = Number(payload.slice(i + 1));
    if (!email || !Number.isFinite(exp) || exp <= Date.now()) return null;
    return email;
  } catch { return null; }
}

/* ---------- sign-in email ---------- */

function renderSignIn(link) {
  return `<div style="margin:0;padding:0;background:#eceff4;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your sign-in link for the Alfano Ministries audio library.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceff4;"><tr><td align="center" style="padding:20px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Georgia,'Times New Roman',serif;">
      <tr><td style="background:#0a162a;padding:22px 28px;text-align:center;">
        <div style="color:#c8a24a;font-size:22px;letter-spacing:2px;font-weight:bold;">ALFANO MINISTRIES</div>
        <div style="color:#9fb0c9;font-size:12px;letter-spacing:3px;margin-top:4px;">AUDIO LIBRARY</div>
      </td></tr>
      <tr><td style="padding:32px 34px 10px;">
        <h1 style="margin:0;color:#0a162a;font-size:24px;">Here is your sign-in link</h1>
        <p style="margin:16px 0 0;color:#333;font-size:16px;line-height:1.65;">Tap the button below and every audiobook opens up. The link works for 30 days on any device, so you can start on your computer and finish on your phone.</p>
      </td></tr>
      <tr><td style="padding:26px 34px 8px;text-align:center;">
        <a href="${link}" style="display:inline-block;background:#c8a24a;color:#0a162a;font-family:Georgia,serif;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 44px;border-radius:8px;">Open the audio library</a>
      </td></tr>
      <tr><td style="padding:18px 34px 8px;">
        <p style="margin:0;color:#88909e;font-size:13px;line-height:1.6;">If the button does not work, paste this into your browser:<br><span style="color:#7a6321;word-break:break-all;">${link}</span></p>
      </td></tr>
      <tr><td style="padding:18px 34px 10px;">
        <p style="margin:0;color:#333;font-size:15px;line-height:1.65;">Thank you for partnering with us. Your giving is what carries these books, and the Gospel, to the nations.</p>
        <p style="margin:14px 0 0;color:#333;font-size:15px;line-height:1.65;">Marc &amp; Christina Alfano</p>
      </td></tr>
      <tr><td style="padding:24px 34px 30px;text-align:center;border-top:1px solid #eef1f6;">
        <div style="color:#0a162a;font-size:14px;font-weight:bold;">Alfano Ministries International Inc</div>
        <div style="color:#88909e;font-size:12px;margin-top:6px;line-height:1.6;">A registered 501(c)(3) ministry &nbsp;&bull;&nbsp; EIN 99-1858016<br><a href="${SITE}" style="color:#7a6321;text-decoration:none;">alfanoministries.com</a></div>
        <div style="color:#b3bac6;font-size:11px;margin-top:12px;line-height:1.5;">You are receiving this because someone asked for a sign-in link for this address. If that was not you, no action is needed and nothing has changed on your account.</div>
      </td></tr>
    </table>
  </td></tr></table>
</div>`;
}

async function sendSignIn(env, toEmail, html) {
  if (!env.RESEND_API_KEY) { console.error("RESEND_API_KEY not set"); return false; }
  try {
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "AlfanoMinistries-AudioLibrary/1.0",
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [toEmail], subject: MAIL_SUBJECT, html }),
    });
    if (r.ok) return true;
    console.error("Resend failed:", r.status, (await r.text()).slice(0, 300));
    return false;
  } catch (e) { console.error("Resend error:", String(e).slice(0, 200)); return false; }
}

/* ---------- handlers ---------- */

// Always the same answer, whether or not the address is entitled. Learning who
// gives to the ministry should not be a side effect of a public endpoint.
const NEUTRAL = { success: true, message: "If that email has access, a sign-in link is on its way." };

async function handleRequest(body, env, safe) {
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ success: false, message: "Enter a valid email address." }, 400, safe);

  // Throttle so this cannot be used to bomb an inbox.
  const rlKey = `rl:${email}`;
  if (await env.AUDIO_ACCESS.get(rlKey)) return json(NEUTRAL, 200, safe);
  await env.AUDIO_ACCESS.put(rlKey, "1", { expirationTtl: REQUEST_THROTTLE_SEC });

  const rec = await readAccess(env, email);
  if (!isEntitled(rec)) return json(NEUTRAL, 200, safe);

  if (!env.ACCESS_TOKEN_SECRET) {
    console.error("ACCESS_TOKEN_SECRET not set");
    return json({ success: false, message: "Sign-in is temporarily unavailable." }, 500, safe);
  }

  const token = await mintToken(email, env.ACCESS_TOKEN_SECRET);
  await sendSignIn(env, email, renderSignIn(`${SITE}/library.html?t=${encodeURIComponent(token)}`));
  return json(NEUTRAL, 200, safe);
}

async function handleUnlock(body, env, safe) {
  if (!env.ACCESS_TOKEN_SECRET) return json({ success: false, unlocked: false }, 500, safe);

  const email = await verifyToken(body.token, env.ACCESS_TOKEN_SECRET);
  if (!email) return json({ success: false, unlocked: false, reason: "invalid" }, 401, safe);

  // Re-check the store: a valid token must not outlive the partnership.
  const rec = await readAccess(env, email);
  if (!isEntitled(rec)) return json({ success: false, unlocked: false, reason: "lapsed" }, 403, safe);

  return json({
    success: true,
    unlocked: true,
    email,
    publicUserId: PUBLIC_USER_ID,
    books: BOOKS,
    accessUntil: rec.permanent ? null : rec.accessUntil || null,
  }, 200, safe);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const ok = ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
    const safe = ok ? origin : ALLOWED_ORIGINS[0];

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(safe) });
    if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405, safe);
    if (!ok) return json({ success: false, message: "Forbidden" }, 403, safe);

    let body;
    try { body = await request.json(); } catch { return json({ success: false, message: "Bad request" }, 400, safe); }

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path === "/request") return handleRequest(body, env, safe);
    if (path === "/unlock") return handleUnlock(body, env, safe);
    return json({ success: false, message: "Not found" }, 404, safe);
  },
};
