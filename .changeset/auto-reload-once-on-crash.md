---
"@sideline/web": patch
---

Automatically reload the app once after a crash before showing the manual recovery
screen. On a post-mount crash the app now silently reloads a single time (showing a
quiet "Reloading…" placeholder); only if it crashes again does the "Something went
wrong" screen appear. The single auto-reload resets once a route renders healthy, is
bounded by the existing reload cap, and is skipped when sessionStorage is unavailable
so it can never loop.
