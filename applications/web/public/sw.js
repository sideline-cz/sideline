// Try to load Workbox from CDN; fall back to basic caching if unavailable
try {
  importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js');
} catch {
  // Workbox unavailable — basic SW continues below
}

const OFFLINE_CACHE = 'offline-fallback';
const STATIC_CACHE = 'static-assets';
// The rules trainer's nine content packages get their OWN cache rather than
// sharing STATIC_CACHE. Sharing would mean practising rules evicts
// app-shell chunks and browsing the app evicts the rules content — which
// defeats the entire point of caching it (a rules argument at a tournament,
// with no signal). A separate cache with a small, sufficient maxEntries makes
// the nine packages evict only each other.
const RULES_CACHE = 'rules-content';
const OFFLINE_URL = '/offline.html';

// Caches this service worker owns. Anything else (e.g. a stale `pages` shell
// from a previous version) is deleted on activate so returning users stop
// running an old, cached app shell. A new cache name MUST be added here or it
// is purged on every activate — i.e. silently never caches anything.
const EXPECTED_CACHES = [OFFLINE_CACHE, STATIC_CACHE, RULES_CACHE];

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

  // Rules trainer content packages, in their own cache — see RULES_CACHE.
  //
  // MUST be registered BEFORE the generic static-asset route below: Workbox
  // matches in registration order, and these chunks are `destination: 'script'`,
  // so the static route would otherwise claim them and put them back into the
  // oversubscribed shared cache.
  //
  // Matched by filename rather than `destination` because that is the only thing
  // that distinguishes them. Vite emits each content package as a hashed JS
  // chunk named after its source file (`01-pull-DCQUq6ss.js`), and the
  // `0N-` prefix is unique to the rules packages — no app module starts with a
  // digit pair. maxEntries is 12 for nine packages plus headroom; maxAge is a
  // year because the content changes only when the rulebook does, and the
  // filename hash makes a real change a cache miss anyway.
  registerRoute(
    ({ url }) => /\/assets\/0[1-9]-[a-z-]+-[\w-]+\.js$/.test(url.pathname),
    new CacheFirst({
      cacheName: RULES_CACHE,
      plugins: [
        new ExpirationPlugin({ maxEntries: 12, maxAgeSeconds: 365 * 24 * 60 * 60 }),
        new CacheableResponsePlugin({ statuses: [0, 200] }),
      ],
    }),
  );

  // Cache static assets (JS, CSS, images, fonts) with CacheFirst. These are
  // content-hashed and immutable, so a new deploy ships new filenames that miss
  // the cache and are fetched fresh — old entries simply age out.
  //
  // `maxEntries` must EXCEED the app's hashed-chunk count or this route silently
  // does nothing useful: it was 100 against ~192 chunks, so LRU eviction thrashed
  // and the cache reported "assets are cached" while holding roughly half of one
  // page load. 250 covers the current bundle with headroom; the 30-day `maxAge`
  // still bounds growth. If the bundle ever passes ~250, raise this — the failure
  // is silent, not an error.
  registerRoute(
    ({ request }) => ['script', 'style', 'image', 'font'].includes(request.destination),
    new CacheFirst({
      cacheName: STATIC_CACHE,
      plugins: [
        new ExpirationPlugin({ maxEntries: 250, maxAgeSeconds: 30 * 24 * 60 * 60 }),
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
  //
  // CONSEQUENCE, measured — read this before promising offline support. Caching
  // an asset (including the rules content above) only helps once the app shell
  // is already running:
  //   - page already open, then signal lost  → keeps working
  //   - COLD START with no signal            → offline.html, not the app
  // So the rules trainer is *not* usable from a cold start at a field with no
  // signal, which is the scenario docs/plans/rules-trainer.md cites.
  //
  // DECIDED (2026-08-26, owner): leave it. Serving a cached shell for
  // navigations would trade away the guarantee above — returning users always
  // get the newest deploy — and it applies app-wide, including to authenticated
  // pages, where a shell can outlive the API contract it was built against. The
  // cold-start-offline scenario is therefore knowingly unmet rather than
  // half-supported. Do not "fix" this incidentally in a feature branch; it is a
  // deliberate trade, and the honest version of it is this comment.
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
