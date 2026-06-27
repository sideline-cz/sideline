---
"@sideline/web": patch
---

fix(web): prevent PWA dead white screen via layered crash recovery

The installed PWA could show a dark loading screen followed by a permanent
white dead screen. Root cause: a render-time crash unmounts the React tree,
which unmounts `ThemeProvider`, dropping the `.dark` class from `<html>` so the
`--background` CSS variable reverts from dark to white.

Adds a layered defense so no crash path can render white: a top-level
`AppErrorBoundary` with a self-themed `AppCrashFallback`, a hardened
`RouteErrorComponent`, and deterministic re-assertion of the resolved theme on
`<html>`/`<body>` in both crash surfaces (robust regardless of which error
boundary catches the throw). The crash UI now resolves the user's chosen theme
(`localStorage` `sideline-theme`) rather than the OS preference. A non-React
pre-mount `<head>` watchdog plus a crash beacon and an OTLP server plugin cover
the case where the bundle never executes (e.g. a stale/404 chunk after a
deploy) and emit telemetry so the next occurrence is diagnosable. Reload loops
are capped (separate crash and service-worker-update counters), a safe
`resetApp` recovery is added, the root loader's initial fetch now always
reaches a definite outcome, and devtools are gated out of production builds.
