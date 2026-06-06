---
"@sideline/web": minor
---

Add OpenTelemetry / SigNoz monitoring for the web application.

Sets up a `ManagedRuntime` singleton (built once per page session) with OTLP JSON export via the Fetch API. Registers Web Vitals metrics (LCP, CLS, FCP, INP, TTFB), page load timing, and React component render duration. OTEL config is optional so local dev works without it configured.
