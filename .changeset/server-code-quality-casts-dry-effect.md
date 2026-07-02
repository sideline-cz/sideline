---
"@sideline/server": patch
---

Code-quality refactor of the finance repositories, RPC handlers, and LlmClient (no behavior change): eliminate `as` type casts by fixing the underlying types (internal `Schema.decodeSync` at boundaries, honest `Option<DateTime.Utc>` input types, branded read-side row schemas, typed empty-array `Effect.succeed`), DRY the `Option<Option<A>>`→nullable partial-update collapse into a shared `nestedOptionToNullable` helper, and replace `LlmClient`'s try/catch decode-with-fallback blocks with `Effect.try` + `Effect.orElseSucceed`. One intentional hardening: the balance-summary money columns are now schema-validated, so a malformed database sum fails loudly instead of being silently coerced.
