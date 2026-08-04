/**
 * Cloudflare Worker: Book Table — record a sale + fire the receipt
 *
 * One POST per completed sale. Two shapes:
 *   CARD:   { stripeSessionId, paymentMethod:"card" }
 *           -> verifies the Stripe session is PAID, reads name/email/phone +
 *              the "email me" opt-in straight from Stripe.
 *   MANUAL: { orderId, paymentMethod:"cash"|"zelle"|"cashapp",
 *             customer:{name,email,phone,marketingConsent}, order:{...pending} }
 *
 * Then it (1) upserts the buyer into GoHighLevel for the mailing list (marketing
 * tag only if they opted in - GDPR-clean), and (2) emails the branded receipt
 * itself via Resend from receipts@alfanoministries.com.
 *
 * SETUP (Cloudflare dashboard -> Workers -> Create "book-sale", paste this):
 *   Settings -> Variables (encrypt all three):
 *     GHL_API_KEY    = your GHL Private Integration Token (same as ghl-signup)
 *     STRIPE_API_KEY = the same restricted Stripe key used by book-checkout
 *     RESEND_API_KEY = a Resend API key (domain alfanoministries.com verified)
 *   Deploy -> copy the workers.dev URL -> sell.html CONFIG.SALE_URL.
 */

const ALLOWED_ORIGINS = [
  "https://alfanoministries.com",
  "https://www.alfanoministries.com",
  "http://localhost",
  "http://127.0.0.1",
];

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_LOCATION_ID = "AIPTqymDwrSMF9zx8Pul";
const STRIPE = "https://api.stripe.com/v1";
const RESEND_URL = "https://api.resend.com/emails";
const RECEIPT_FROM = "Alfano Ministries <receipts@alfanoministries.com>";
const RECEIPT_SUBJECT = "Your receipt - thank you from Alfano Ministries";

const BUYER_TAG = "event book sale";     // marks book buyers (segmentation)
const OPTIN_TAG = "email opt-in";        // marketing consent (only added if opted in)

// Currency display — matches sell.html.
const CUR_SYM = { USD:"$", EUR:"€", GBP:"£", PLN:"zł", HUF:"Ft", TRY:"₺", MUR:"₨" };
const ZERO_DEC = ["JPY","KRW","VND","CLP","ISK","HUF","UGX","XAF","XOF","RWF"];

const money = (amt, cur) => (CUR_SYM[cur] || cur + " ") + Number(amt || 0).toFixed(ZERO_DEC.includes(cur) ? 0 : 2);
const fromMinor = (amt, cur) => (ZERO_DEC.includes(cur) ? amt : amt / 100);

function genOrderId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `AM-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
function today() {
  try { return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
const payLabel = (m) => ({ card: "Card", cash: "Cash", zelle: "Zelle", cashapp: "Cash App" }[m] || "Card");

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

function ghlHeaders(key) {
  return { Authorization: `Bearer ${key}`, Version: "2021-07-28", "Content-Type": "application/json" };
}

// Split a full name into first / last.
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
}

// --- Build the receipt fields from either sale type into one shape ---
function fieldsFromStripe(session) {
  const cur = String(session.currency || "usd").toUpperCase();
  const lines = (session.line_items?.data) || [];
  const bookLines = [];
  let booksMinor = 0, giftMinor = 0;
  for (const li of lines) {
    const name = li.description || "Item";
    const isGift = /gift to (the )?(alfano )?ministr/i.test(name);
    if (isGift) { giftMinor += li.amount_total; continue; }
    booksMinor += li.amount_total;
    bookLines.push(`${li.quantity} x ${name}  ${money(fromMinor(li.amount_total, cur), cur)}`);
  }
  return {
    currency: cur,
    email: session.customer_details?.email || "",
    name: session.customer_details?.name || "",
    phone: session.customer_details?.phone || "",
    consent: session.consent?.promotions === "opt_in",
    items: bookLines.join("\n"),
    booksTotal: money(fromMinor(booksMinor, cur), cur),
    gift: giftMinor > 0 ? money(fromMinor(giftMinor, cur), cur) : "None",
    total: money(fromMinor(session.amount_total, cur), cur),
  };
}
function fieldsFromManual(body) {
  const order = body.order || {};
  const cur = String(order.currency || "USD").toUpperCase();
  const c = body.customer || {};
  const items = (order.items || []).filter((i) => !i.gift && i.id !== "ministry-gift");
  const gift = Number(order.gift || 0);
  const total = Number(order.totalCUR || 0);
  const bookLines = items.map((i) => `${i.qty} x ${i.title}  ${money(Number(i.unit) * i.qty, cur)}`);
  return {
    currency: cur,
    email: c.email || "",
    name: c.name || "",
    phone: c.phone || "",
    consent: c.marketingConsent === true,
    items: bookLines.join("\n"),
    booksTotal: money(total - gift, cur),
    gift: gift > 0 ? money(gift, cur) : "None",
    total: money(total, cur),
  };
}

async function getStripeSession(id, key) {
  const r = await fetch(`${STRIPE}/checkout/sessions/${id}?expand[]=line_items`, { headers: { Authorization: `Bearer ${key}` } });
  return r.ok ? r.json() : null;
}

// Upsert the contact with order fields; returns { id, tags }.
async function upsertContact(f, orderId, orderDate, paymentLabel, key) {
  const { firstName, lastName } = splitName(f.name);
  const payload = {
    locationId: GHL_LOCATION_ID,
    source: "Book table",
    tags: f.consent ? [BUYER_TAG, OPTIN_TAG] : [BUYER_TAG],
    customFields: [
      { key: "order_number", field_value: orderId },
      { key: "order_date", field_value: orderDate },
      { key: "order_items", field_value: f.items },
      { key: "order_books_total", field_value: f.booksTotal },
      { key: "order_gift", field_value: f.gift },
      { key: "order_total", field_value: f.total },
      { key: "order_payment", field_value: paymentLabel },
    ],
  };
  if (f.email) payload.email = f.email;
  if (f.phone) payload.phone = f.phone;
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;

  const r = await fetch(`${GHL_BASE}/contacts/upsert`, { method: "POST", headers: ghlHeaders(key), body: JSON.stringify(payload) });
  if (!r.ok) { console.error("GHL upsert failed:", r.status, await r.text()); return null; }
  const d = await r.json();
  return { id: d.contact?.id, tags: d.contact?.tags || [] };
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Build the branded receipt HTML with the order values filled in.
function renderReceipt(f, orderId, orderDate, paymentLabel) {
  const { firstName } = splitName(f.name);
  const name = esc(firstName || "friend");
  const items = esc(f.items);
  return `<div style="margin:0;padding:0;background:#eceff4;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Thank you for your order and for supporting the ministry.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceff4;"><tr><td align="center" style="padding:20px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Georgia,'Times New Roman',serif;">
      <tr><td style="background:#0a162a;padding:22px 28px;text-align:center;">
        <div style="color:#c8a24a;font-size:22px;letter-spacing:2px;font-weight:bold;">ALFANO MINISTRIES</div>
        <div style="color:#9fb0c9;font-size:12px;letter-spacing:3px;margin-top:4px;">INTERNATIONAL</div>
      </td></tr>
      <tr><td style="padding:0;"><img src="https://alfanoministries.com/assets/email/alfano-family-europe.jpg" width="600" alt="The Alfano family" style="display:block;width:100%;max-width:600px;height:auto;"></td></tr>
      <tr><td style="padding:30px 34px 8px;">
        <h1 style="margin:0;color:#0a162a;font-size:26px;">Thank you, ${name}!</h1>
        <p style="margin:16px 0 0;color:#333;font-size:16px;line-height:1.65;">From our family to yours, thank you for picking up a book today. We pray it draws you closer to the Lord and stirs up the gift He has placed in you. Every book you carry home carries the Gospel a little farther, and it helps us keep going to the nations.</p>
        <p style="margin:14px 0 0;color:#333;font-size:16px;line-height:1.65;">With love and gratitude,<br><strong>Marc &amp; Christina Alfano</strong></p>
      </td></tr>
      <tr><td style="padding:22px 34px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e6ee;border-radius:12px;">
          <tr><td style="padding:18px 20px 6px;">
            <div style="color:#0a162a;font-size:13px;letter-spacing:1.5px;font-weight:bold;">YOUR ORDER</div>
            <div style="color:#88909e;font-size:12px;margin-top:3px;">Order ${esc(orderId)} &nbsp;&bull;&nbsp; ${esc(orderDate)} &nbsp;&bull;&nbsp; Paid by ${esc(paymentLabel)}</div>
          </td></tr>
          <tr><td style="padding:6px 20px;"><div style="white-space:pre-line;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2f3a;line-height:1.7;border-top:1px solid #eef1f6;border-bottom:1px solid #eef1f6;padding:12px 0;">${items}</div></td></tr>
          <tr><td style="padding:10px 20px 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Georgia,serif;font-size:15px;color:#2a2f3a;">
              <tr><td style="padding:4px 0;">Books</td><td align="right" style="padding:4px 0;">${esc(f.booksTotal)}</td></tr>
              <tr><td style="padding:4px 0;color:#7a6321;">Gift to the ministry</td><td align="right" style="padding:4px 0;color:#7a6321;">${esc(f.gift)}</td></tr>
              <tr><td style="padding:10px 0 4px;border-top:2px solid #0a162a;font-weight:bold;font-size:17px;color:#0a162a;">Total paid</td><td align="right" style="padding:10px 0 4px;border-top:2px solid #0a162a;font-weight:bold;font-size:17px;color:#0a162a;">${esc(f.total)}</td></tr>
            </table>
          </td></tr>
          <tr><td style="padding:6px 20px 18px;"><p style="margin:0;color:#88909e;font-size:12px;line-height:1.55;">Alfano Ministries International Inc is a registered 501(c)(3). The book price is a purchase; any gift you added above it is a tax-deductible contribution. EIN 99-1858016. Please keep this receipt for your records.</p></td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:26px 34px 6px;"><img src="https://alfanoministries.com/assets/email/marc-preaching-2026.jpg" width="532" alt="Marc preaching" style="display:block;width:100%;max-width:532px;height:auto;border-radius:12px;"></td></tr>
      <tr><td style="padding:16px 34px 4px;text-align:center;">
        <h2 style="margin:0;color:#0a162a;font-size:20px;">Want to send us further?</h2>
        <p style="margin:12px 0 20px;color:#333;font-size:15px;line-height:1.6;">Your giving puts these books into more hands and takes us to more nations. If the Lord stirs you to give again, we would be honored.</p>
        <a href="https://www.zeffy.com/en-US/donation-form/1233096c-7bc9-4427-9173-31614d53ba49" style="display:inline-block;background:#c8a24a;color:#0a162a;font-family:Georgia,serif;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 40px;border-radius:8px;">Give to the ministry</a>
      </td></tr>
      <tr><td style="padding:26px 34px 30px;text-align:center;border-top:1px solid #eef1f6;">
        <div style="color:#0a162a;font-size:14px;font-weight:bold;">Alfano Ministries International Inc</div>
        <div style="color:#88909e;font-size:12px;margin-top:6px;line-height:1.6;">A registered 501(c)(3) ministry &nbsp;&bull;&nbsp; EIN 99-1858016<br><a href="https://alfanoministries.com" style="color:#7a6321;text-decoration:none;">alfanoministries.com</a></div>
      </td></tr>
    </table>
  </td></tr></table>
</div>`;
}

// Email the receipt through Resend. Returns { ok, status, error } for diagnostics.
async function sendReceipt(env, toEmail, html) {
  if (!env.RESEND_API_KEY) return { ok: false, status: 0, error: "RESEND_API_KEY not set" };
  try {
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "AlfanoMinistries-BookTable/1.0",
      },
      body: JSON.stringify({ from: RECEIPT_FROM, to: [toEmail], subject: RECEIPT_SUBJECT, html }),
    });
    const txt = await r.text();
    if (r.ok) return { ok: true };
    console.error("Resend failed:", r.status, txt);
    return { ok: false, status: r.status, error: txt.slice(0, 300) };
  } catch (e) { return { ok: false, status: 0, error: String(e).slice(0, 200) }; }
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

    const isCard = body.paymentMethod === "card" || !!body.stripeSessionId;
    let fields, orderId;

    if (isCard) {
      if (!body.stripeSessionId) return json({ success: false, message: "Missing session" }, 400, safe);
      const session = await getStripeSession(body.stripeSessionId, env.STRIPE_API_KEY);
      if (!session) return json({ success: false, message: "Could not read payment" }, 502, safe);
      if (session.payment_status !== "paid") return json({ success: false, message: "Payment not completed" }, 402, safe);
      fields = fieldsFromStripe(session);
      orderId = genOrderId();
    } else {
      fields = fieldsFromManual(body);
      orderId = body.orderId || genOrderId();
    }

    if (!fields.email) return json({ success: false, message: "No email on this sale" }, 400, safe);

    const orderDate = today();
    const paymentLabel = payLabel(body.paymentMethod);

    // Add to the GHL mailing list (non-fatal: the receipt must still go out).
    let listed = false;
    try {
      const contact = await upsertContact(fields, orderId, orderDate, paymentLabel, env.GHL_API_KEY);
      listed = !!contact?.id;
    } catch (err) { console.error("GHL upsert error:", err); }

    // Email the branded receipt via Resend.
    const html = renderReceipt(fields, orderId, orderDate, paymentLabel);
    const rc = await sendReceipt(env, fields.email, html);

    return json({ success: true, orderId, email: fields.email, receiptSent: rc.ok, receiptError: rc.ok ? undefined : rc, listed }, 200, safe);
  },
};
