/* Book Table — service worker: cache the app shell + covers for offline catalog use.
   Payment + capture still require connectivity (handled network-first). */
const CACHE = "booktable-v2";
const SHELL = [
  "sell.html",
  "sell.webmanifest",
  "assets/sell-icon.png",
  "assets/pay/cashapp-qr.jpg",
  "assets/pay/zelle-qr.jpg",
  "assets/books/the-last-convert-cover.jpg",
  "assets/books/daily-sword-cover.jpg",
  "assets/books/now-faith-cover.jpg",
  "assets/books/now-faith-journal-cover.jpg",
  "assets/books/nf-bundle-cover.jpg",
  "assets/books/wiser-than-ai-cover.jpg",
  "assets/books/go-cover.jpg",
  "assets/books/faith-to-build-cover.jpg",
  "assets/books/sammy-comes-home-cover.jpg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;                 // never cache POSTs (checkout/sale)
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;             // let API/FX/Stripe hit the network

  // The app HTML is network-first: always load the latest when online, fall back to cache offline.
  const isDoc = e.request.mode === "navigate" || url.pathname.endsWith("/sell.html") || url.pathname.endsWith("sell.html");
  if (isDoc) {
    e.respondWith(
      fetch(e.request).then((resp) => {
        if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put("sell.html", copy)); }
        return resp;
      }).catch(() => caches.match("sell.html"))
    );
    return;
  }

  // Static assets (covers, QR, icon, manifest) are cache-first for instant, offline-safe loads.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => hit)
    )
  );
});
