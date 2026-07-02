---
'@sideline/bot': patch
---

Eliminate remaining `as` casts in bot personalEvents/event/carpool: replace `Snowflake` casts with `Discord.Snowflake.makeUnsafe`, use explicit `Option` type args instead of widening casts, and drop redundant no-op `InteractionCallbackTypes` enum self-casts.
