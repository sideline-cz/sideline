---
"@sideline/bot": patch
"@sideline/server": patch
"@sideline/domain": patch
"@sideline/i18n": patch
"@sideline/docs": patch
---

Add an admin "Remove option" button to polls. Captains/admins can remove one or
more options from an open poll via an ephemeral select menu; votes for removed
options are deleted and the remaining options are renumbered so their letters stay
contiguous. A poll always keeps at least two options.
