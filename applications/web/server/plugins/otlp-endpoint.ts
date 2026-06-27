import { definePlugin as defineNitroPlugin } from 'nitro';

export default defineNitroPlugin((nitroApp) => {
  const originalFetch = nitroApp.fetch.bind(nitroApp);

  nitroApp.fetch = async (req) => {
    const res = await originalFetch(req);

    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!otlpEndpoint) return res;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return res;

    const body = await res.text();
    const script = `<script>window.__SIDELINE_OTLP__ = ${JSON.stringify(otlpEndpoint)};</script>`;
    const rewritten = body.replace('</head>', `${script}</head>`);

    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');

    return new Response(rewritten, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
});
