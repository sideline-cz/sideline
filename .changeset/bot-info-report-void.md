---
"@sideline/server": patch
---

Fix the `BotInfo/ReportBotInfo` RPC failing to encode its response, which logged a "Failed to report bot version" warning on every bot startup. `BotInfoStore.set` is typed `Effect<void>` but `Ref.set` yields the underlying ref at runtime in this Effect v4 beta, so the handler's success value failed to encode against the RPC's `Void` success schema ("Expected void, got MutableRef…"). Force the result to void with `Effect.asVoid`. Adds a regression test asserting the real `BotInfoStore.set` resolves to `undefined`.
