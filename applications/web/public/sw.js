// Try to load Workbox from CDN; fall back to basic caching if unavailable
try {
  importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js');
} catch {
  // Workbox unavailable — basic SW continues below
}

const OFFLINE_CACHE = 'offline-fallback';
const STATIC_CACHE = 'static-assets';
const OFFLINE_URL = '/offline.html';

// Caches this service worker owns. Anything else (e.g. a stale `pages` shell
// from a previous version) is deleted on activate so returning users stop
// running an old, cached app shell.
const EXPECTED_CACHES = [OFFLINE_CACHE, STATIC_CACHE];

// Pure helper (kept inline since this file is not an importable module): returns
// true when a cache name does not belong to the current SW and should be purged.
function shouldDeleteCache(cacheName) {
  return !EXPECTED_CACHES.includes(cacheName);
}

// Precache offline.html and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter(shouldDeleteCache).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

// Set up Workbox routes if available
if (typeof workbox !== 'undefined') {
  const { registerRoute } = workbox.routing;
  const { CacheFirst, NetworkOnly } = workbox.strategies;
  const { ExpirationPlugin } = workbox.expiration;
  const { CacheableResponsePlugin } = workbox.cacheableResponse;

  // Cache static assets (JS, CSS, images, fonts) with CacheFirst. These are
  // content-hashed and immutable, so a new deploy ships new filenames that miss
  // the cache and are fetched fresh — old entries simply age out.
  registerRoute(
    ({ request }) => ['script', 'style', 'image', 'font'].includes(request.destination),
    new CacheFirst({
      cacheName: STATIC_CACHE,
      plugins: [
        new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 }),
        new CacheableResponsePlugin({ statuses: [0, 200] }),
      ],
    }),
  );

  // API responses use NetworkOnly — no caching to prevent cross-user data leaks
  // (authenticated responses vary by Authorization header which is not in the cache key)
  registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

  // Navigation requests use NetworkOnly — the app document is dynamic and must
  // ALWAYS come from the network so a freshly deployed shell (and the new hashed
  // bundles it references) reaches returning users. Never serve a cached shell;
  // fall back to offline.html only when the network is genuinely unavailable.
  registerRoute(
    ({ request }) => request.mode === 'navigate',
    new NetworkOnly({
      plugins: [
        {
          handlerDidError: async () => {
            const cachedResponse = await caches.match(OFFLINE_URL);
            if (cachedResponse) {
              return cachedResponse;
            }
            return new Response(
              '<!doctype html><html><head><meta charset="UTF-8"><title>Offline</title></head><body><h1>You are offline</h1></body></html>',
              { headers: { 'Content-Type': 'text/html; charset=UTF-8' } },
            );
          },
        },
      ],
    }),
  );
} else {
  // Fallback: basic fetch handler when Workbox is unavailable
  self.addEventListener('fetch', (event) => {
    if (event.request.mode === 'navigate') {
      event.respondWith(
        fetch(event.request).catch(async () => {
          const cachedResponse = await caches.match(OFFLINE_URL);
          if (cachedResponse) {
            return cachedResponse;
          }
          return new Response(
            '<!doctype html><html><head><meta charset="UTF-8"><title>Offline</title></head><body><h1>You are offline</h1></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=UTF-8' } },
          );
        }),
      );
    }
  });
}
