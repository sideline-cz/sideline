---
'@sideline/web': patch
---

Fix an `Uncaught undefined` crash that appeared immediately after Discord login. The post-login self-redirect (used to strip the `?token=` param) aborts the in-flight navigation, and the interrupted Effect run was letting a bare `undefined` escape to the router. Server runs now go through `Effect.runPromiseExit` with a correctly-wired abort signal: superseded navigations are dropped cleanly, genuine defects surface as real errors (never `undefined`), and `Redirect`/`NotFound` behaviour is preserved.
