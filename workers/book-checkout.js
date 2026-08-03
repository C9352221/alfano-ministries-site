/**
 * Cloudflare Worker: Book Table — Stripe Checkout
 *
 * Creates a Stripe Checkout Session in the buyer's currency from an AUTHORITATIVE
 * server-side price list, so a tampered cart can never underpay. Returns the hosted
 * checkout URL. The app opens it; on payment Stripe returns to sell.html?paid=<id>.
 *
 * SETUP (Cloudflare dashboard → Workers → Create):
 *   1. Name it "book-checkout", paste this file.
 *   2. Settings → Variables → add (encrypt):
 *        STRIPE_API_KEY = a Stripe RESTRICTED key with write access to
 *                         "Checkout Sessions" (and Products + Prices).
 *      Use a TEST key (rk_test_…) first, swap to live (rk_live_…) when ready.
 *   3. Deploy → copy the workers.dev URL → put it in sell.html CONFIG.CHECKOUT_URL.
 *
 * Keep PRICES below in sync with the BOOKS list in sell.html.
 */

const ALLOWED_ORIGINS = [
  "https://alfanoministries.com",
  "https://www.alfanoministries.com",
  "http://localhost",
  "http://127.0.0.1",
];
const SITE = "https://alfanoministries.com";        // success/cancel redirect base
const STRIPE = "https://api.stripe.com/v1";

// Authoritative selling prices (USD). MUST match sell.html BOOKS.
const PRICES = {
  "last-convert":   { name: "The Last Convert",            formats: { Paperback: 16, Hardcover: 25 } },
  "daily-sword":    { name: "The Daily Sword",             formats: { Paperback: 30, Hardcover: 50 } },
  "now-faith":      { name: "Now Faith",                   usd: 15 },
  "nf-journal":     { name: "The Now Faith Journal",       usd: 17 },
  "nf-bundle":      { name: "Now Faith + Journal Bundle",  usd: 30 },
  "wiser":          { name: "Wiser Than AI",               usd: 12 },
  "go":             { name: "GO",                          usd: 15 },
  "faith-to-build": { name: "Faith to Build",              usd: 12 },
  "sammy":          { name: "Sammy Comes Home",            usd: 17 },
};

const usdFor = (id, format) => {
  const b = PRICES[id];
  if (!b) return null;
  if (b.formats) return b.formats[format] ?? Object.values(b.formats)[0];
  return b.usd;
};
const nameFor = (id, format) => {
  const b = PRICES[id];
  if (!b) return id;
  return b.name + (b.formats && format ? ` (${format})` : "");
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function fxRate(currency) {
  if (currency === "USD") return 1;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const d = await r.json();
    return d.rates?.[currency] ?? null;
  } catch { return null; }
}
// Convert a USD amount to the sale currency, matching the app exactly:
// USD is exact; every other currency rounds UP to a whole number.
function convert(usd, currency, rate) {
  return currency === "USD" ? Math.round(usd * 100) / 100 : Math.ceil(usd * rate);
}
const minorUnits = (amount) => Math.round(amount * 100);   // whole amounts -> *100 for Stripe

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const ok = ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
    const safe = ok ? origin : ALLOWED_ORIGINS[0];

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(safe) });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, safe);
    if (!ok) return json({ error: "Forbidden" }, 403, safe);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400, safe); }

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json({ error: "Empty cart" }, 400, safe);
    const cur = String(body.currency || "USD").toUpperCase();
    const rate = await fxRate(cur);
    if (rate === null) return json({ error: "Exchange rate unavailable" }, 400, safe);

    const form = new URLSearchParams();
    form.append("mode", "payment");
    form.append("success_url", `${SITE}/sell.html?paid={CHECKOUT_SESSION_ID}`);
    form.append("cancel_url", `${SITE}/sell.html?canceled=1`);
    form.append("customer_creation", "always");
    form.append("phone_number_collection[enabled]", "true");

    let i = 0, totalCUR = 0;
    for (const it of items) {
      const usd = usdFor(it.id, it.format);
      if (usd == null) continue;                                    // ignore unknown ids (anti-tamper)
      const qty = Math.max(1, Math.min(99, parseInt(it.qty) || 1));
      const unit = convert(usd, cur, rate);
      totalCUR += unit * qty;
      form.append(`line_items[${i}][price_data][currency]`, cur.toLowerCase());
      form.append(`line_items[${i}][price_data][product_data][name]`, nameFor(it.id, it.format));
      form.append(`line_items[${i}][price_data][unit_amount]`, String(minorUnits(unit)));
      form.append(`line_items[${i}][quantity]`, String(qty));
      i++;
    }
    if (i === 0) return json({ error: "No valid items" }, 400, safe);

    // Round-up gift (server-recomputed to next $5/$10, tax-deductible line)
    const step = [5, 10].includes(Number(body.giftStep)) ? Number(body.giftStep) : 0;
    if (step) {
      const gift = (Math.floor(totalCUR / step) + 1) * step - totalCUR;
      if (gift > 0) {
        form.append(`line_items[${i}][price_data][currency]`, cur.toLowerCase());
        form.append(`line_items[${i}][price_data][product_data][name]`, "Gift to Alfano Ministries (tax-deductible)");
        form.append(`line_items[${i}][price_data][unit_amount]`, String(minorUnits(gift)));
        form.append(`line_items[${i}][quantity]`, "1");
        form.append("metadata[gift_amount]", String(gift));
        i++;
      }
    }
    form.append("metadata[currency]", cur);

    try {
      const res = await fetch(`${STRIPE}/checkout/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.STRIPE_API_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      const data = await res.json();
      if (res.ok && data.url) return json({ url: data.url, id: data.id }, 200, safe);
      console.error("Stripe error:", res.status, JSON.stringify(data));
      return json({ error: data.error?.message || "Could not start checkout." }, 502, safe);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: "Service unavailable." }, 503, safe);
    }
  },
};
