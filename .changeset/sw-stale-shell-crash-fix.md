---
"@sideline/web": patch
---

Fix white-page crash for returning users caused by a stale service worker

Returning visitors kept hitting a full white page with `Uncaught (in promise)
undefined` because the service worker served a stale, cached app shell (and the
old hashed JS bundles it referenced), so a previously deployed crash fix never
reached them. Hard-refreshing or clearing site data worked around it.

Navigation requests now use `NetworkOnly` with the existing `offline.html`
fallback so the app document always comes from the network and a freshly
deployed shell reaches users immediately. The service worker now purges any
unexpected caches (such as the old `pages` shell) on activate, and the app
reloads once when an updated service worker takes control — so returning users
escape stale code automatically.

Note: offline navigation now always shows `offline.html` rather than a cached
last-known shell. Immutable, content-hashed static assets are still cached.
