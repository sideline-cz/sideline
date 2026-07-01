---
"@sideline/bot": patch
---

fix: name personal-events overflow categories the same as the base category

When the personal-events category hits Discord's 50-channel limit and the bot
creates an overflow category, it now reuses the base category's exact name
instead of appending a ` (N)` sequence suffix.
