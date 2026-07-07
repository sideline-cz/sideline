---
"@sideline/server": patch
---

Remove redundant `undefined as undefined` (and one `undefined as unknown as undefined`) casts at the `Schema.Void`-request call sites in `TeamSettingsRepository` and `EventSeriesRepository`. The request parameter is already `void`, to which `undefined` is directly assignable, so the casts were no-ops. Compile-time only — the emitted JavaScript is unchanged.
