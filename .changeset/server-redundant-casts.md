---
"@sideline/server": patch
---

Eliminate redundant type casts in server repositories and activity RPC (empty-array `Effect.succeed<T>([])`, no-op `emoji` cast, redundant `ReadonlySet` cast).
