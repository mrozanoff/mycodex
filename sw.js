/* ===========================================================
   Mycodex service worker — enables offline use after first visit.

   Strategy:
   - App shell (html/css/js/manifest/icons): cache-first, so the
     site itself loads instantly and works with no connection.
   - Data files (inat_data.json / manual_data.csv): network-first,
     falling back to the last cached copy if offline. This way you
     always see fresh data when online, but still see your last
     synced data when you don't have a signal in the field.

   Bump CACHE_VERSION whenever you change index.html/style.css/app.js
   so returning visitors pick up the update instead of a stale cache.
=========================================================== */
const CACHE_VERSION = "mycodex-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

const DATA_PATHS = ["/data/inat_data.json", "/data/manual_data.csv"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch((err) => {
      // Don't let one failed asset (e.g. an offline install) block the rest.
      console.warn("Service worker install: some assets failed to cache", err);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only handle same-origin requests here; let cross-origin (Google Fonts,
  // a published Google Sheet CSV, jsdelivr) pass straight through to the
  // network as normal, since caching opaque cross-origin responses safely
  // is more trouble than it's worth for this use case.
  if (url.origin !== self.location.origin) return;

  const isData = url.pathname.includes("/data/inat_data.json") || url.pathname.includes("/data/manual_data.csv");

  if (isData) {
    // Network-first for data, falling back to cache when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for the app shell (fast load, works offline).
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      });
    })
  );
});
