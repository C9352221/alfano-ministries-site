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
 * Then it upserts the buyer into GoHighLevel with the order details on custom
 * fields, and (re)adds the "event book sale" tag to trigger the receipt email
 * workflow. Marketing tag is added ONLY if the buyer opted in (GDPR-clean).
 *
 * SETUP (Cloudflare dashboard -> Workers -> Create "book-sale", paste this):
 *   Settings -> Variables (encrypt both):
 *     GHL_API_KEY    = your GHL Private Integration Token (same as ghl-signup)
 *     STRIPE_API_KEY = the same restricted Stripe key used by book-checkout
 *   Deploy -> copy the workers.dev URL -> sell.html CONFIG.SALE_URL.
 *
 * The receipt itself lives in GHL (email template + workflow). This worker only
 * supplies the data and pulls the trigger.
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

const RECEIPT_TAG = "event book sale";   // triggers the GHL receipt workflow
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
    tags: f.consent ? [OPTIN_TAG] : [],
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

// Remove-then-add the receipt tag so the workflow re-fires for repeat buyers.
async function fireReceiptTag(contactId, existingTags, key) {
  const url = `${GHL_BASE}/contacts/${contactId}`;
  const headers = ghlHeaders(key);
  const without = (existingTags || []).filter((t) => t !== RECEIPT_TAG);
  if ((existingTags || []).includes(RECEIPT_TAG)) {
    await fetch(url, { method: "PUT", headers, body: JSON.stringify({ tags: without }) });
    await new Promise((r) => setTimeout(r, 500));
  }
  await fetch(url, { method: "PUT", headers, body: JSON.stringify({ tags: [...without, RECEIPT_TAG] }) });
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

    try {
      const contact = await upsertContact(fields, orderId, today(), payLabel(body.paymentMethod), env.GHL_API_KEY);
      if (!contact?.id) return json({ success: false, message: "Could not save contact" }, 502, safe);
      await fireReceiptTag(contact.id, contact.tags, env.GHL_API_KEY);
      return json({ success: true, orderId, email: fields.email }, 200, safe);
    } catch (err) {
      console.error("book-sale error:", err);
      return json({ success: false, message: "Service error" }, 503, safe);
    }
  },
};
