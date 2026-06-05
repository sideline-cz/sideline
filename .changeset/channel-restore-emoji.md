---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/web": minor
"@sideline/i18n": minor
"@sideline/migrations": minor
---

Restore archived channels and set a channel emoji

Admins can now restore an archived channel (single, with bulk support on the
server) — moving it back out of the configured archive category. Managed-channel
archiving keeps the Discord link so a restored channel re-activates cleanly.

When creating a channel, admins can specify an emoji; the channel's Discord name
is composed from the team's configured channel name format (e.g. `{emoji}│{name}`),
with a live preview in the create dialog.
