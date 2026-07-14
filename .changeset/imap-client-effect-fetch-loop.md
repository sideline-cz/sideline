---
"@sideline/server": patch
---

Convert the `ImapClient.fetchSince` fetch loop to a proper Effect pipeline. The mailbox lock and fetch iterator are now managed with `Effect.acquireRelease` (deterministic teardown in reverse order — iterator → lock → logout), uid-watermark validation fails with a typed `ImapConnectionError` instead of a thrown one, and the two `console.warn` break-warnings (the only `console.*` calls left in the server) are replaced with `Effect.logWarning` so they reach structured logging/SigNoz. The contiguous-prefix break, uid validation, and payload-mapping behaviour are unchanged and pinned by the `ImapClient.fetchSince` unit tests.
