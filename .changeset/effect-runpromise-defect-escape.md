---
"@sideline/web": patch
---

Fix `Uncaught undefined` crash after Discord login (real root cause)

`fetchTranslations` and `fetchVersions` used bare `Effect.runPromise` which
only catches typed errors — any defect or interrupt (e.g. an aborted fetch
during the post-login redirect sequence) escaped as an unhandled
`Uncaught (in promise) undefined`, crashing the page.

Both now use `Effect.runPromiseExit` + `Exit.isSuccess` so defects are
silently treated as "no data" rather than crashing the app.
