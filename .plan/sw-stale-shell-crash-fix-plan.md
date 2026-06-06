# Bug Fix Plan — Stale Service Worker Serves Old Broken Bundle (white page + `Uncaught (in promise) undefined`)

**Bug:** Loading https://sideline.cz renders a full white page and logs `Uncaught (in promise) undefined`
for **returning users**. A fresh browser works fine, and a hard refresh / clearing site data fixes it.

## Root cause (reproduced)

- PR #345 (`fix(web): prevent Uncaught undefined crash after Discord login`) is **already deployed** — the
  live `runtime-*.js` bundle contains the fix, and a clean headless browser loads the site without error.
- The PWA service worker (`applications/web/public/sw.js`, registered in `RootDocument.tsx`) caches the
  **navigation/app-shell** with Workbox `NetworkFirst` (`pages` cache) and static JS/CSS with `CacheFirst`
  (`static-assets`). It has **no cache versioning, no purge-on-activate, and no update→reload logic**, and
  `sw.js` has never changed since introduction (commit #125).
- Reproduced with Playwright: after priming the SW then simulating a new origin deploy, a **soft reload
  still served the stale cached shell** (`=> STALE SHELL SERVED FROM SW CACHE`), not the fresh origin
  document. The document is `cf-cache-status: DYNAMIC` with no `cache-control`, so it should always be
  fetched fresh — but the SW serves its cached copy.
- Net effect: returning users keep running the **old, pre-#345 bundle** (old hashed assets pinned by
  `CacheFirst`, old shell served by the SW), so they still hit the original `Uncaught (in promise)
  undefined` crash. The deployed fix never reaches them. Hard refresh bypasses the SW → fresh code → works.

## Fix

### `applications/web/public/sw.js`
1. Introduce `CACHE_VERSION` and version all cache names (`offline-<v>`, `static-assets-<v>`).
2. On `activate`: **delete every cache not in the current keep-set** (purges stale `pages`,
   `static-assets`, `offline-fallback`), then `clients.claim()`. This one-time purge unsticks currently
   broken users when the new SW activates.
3. **Navigation → `NetworkOnly` + offline.html fallback** (instead of `NetworkFirst`). The app document is
   dynamic and must always come from the network; the SW must never serve a stale app shell. Offline →
   show `offline.html`. Mirror this in the non-Workbox basic fallback (already network-only).
4. Keep `CacheFirst` for immutable content-hashed assets (correct; fresh HTML references new hashes → cache
   miss → network). Changing the file bytes makes browsers install the new SW (skipWaiting already present).

### `applications/web/src/components/layouts/RootDocument.tsx`
5. After `register('/sw.js')`, listen for `controllerchange` and reload the page **once** (loop-guarded) so a
   newly activated SW takes effect immediately without a manual refresh.

## Why this reaches already-broken users
Browsers re-check `/sw.js` on navigation (HTTP `max-age=14400`). The changed bytes → new SW installs →
`skipWaiting` → `activate` purges old caches → `clients.claim()`. Even if the crashed white page never runs
the reload listener, the next manual reload now gets purged caches + `NetworkOnly` fresh document → fixed.

## Tests
- Unit-test the pure cache-cleanup predicate (which cache names are kept vs deleted) if extracted.
- Manual/Playwright: prime SW, simulate new deploy, soft reload → serves fresh (not stale) shell; offline →
  offline.html.

## Scope
Web only: `applications/web/public/sw.js`, `applications/web/src/components/layouts/RootDocument.tsx`.
No domain/API/schema changes. Changeset: patch `web`.
