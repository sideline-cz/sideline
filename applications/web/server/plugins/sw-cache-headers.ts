import { definePlugin as defineNitroPlugin } from 'nitro';

// The service worker script must never be pinned by a long-lived browser/CDN
// cache: a stale `sw.js` keeps an old worker (and the old cached app it serves)
// alive, which is exactly how a deployed fix fails to reach returning users.
// Send `Cache-Control: no-cache` so the browser always revalidates `sw.js`
// against the origin before reusing it. Cloudflare passes `no-cache` through.
export default defineNitroPlugin((nitroApp) => {
  const originalFetch = nitroApp.fetch.bind(nitroApp);

  nitroApp.fetch = async (req) => {
    const res = await originalFetch(req);

    if (new URL(req.url).pathname !== '/sw.js') {
      return res;
    }

    const headers = new Headers(res.headers);
    headers.set('cache-control', 'no-cache');

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
});
