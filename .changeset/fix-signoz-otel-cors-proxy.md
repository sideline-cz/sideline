---
"@sideline/proxy": patch
"@sideline/web": patch
"@sideline/server": patch
---

Route frontend OTEL telemetry through the nginx proxy to avoid cross-origin issues with the SigNoz collector. The browser OTEL exporter now posts to the same-origin `/otel/` path which nginx proxies to the collector, eliminating CORS preflight failures. Also bumps server to pick up the migrations 0.18.1 patch.
