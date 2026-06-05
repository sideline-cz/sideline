---
"@sideline/web": patch
---

Serve the service worker script with `Cache-Control: no-cache`

`sw.js` is now sent with `Cache-Control: no-cache` from the origin so the
browser always revalidates it against the server. A stale, long-cached service
worker keeps an old worker (and the old cached app it serves) alive, which
delays deployed fixes from reaching returning users. `no-cache` makes a newly
deployed service worker take effect promptly. Cloudflare passes the origin
`no-cache` through to the browser.
