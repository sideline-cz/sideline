---
"@sideline/domain": patch
"@sideline/i18n": patch
"@sideline/server": patch
"@sideline/bot": patch
"@sideline/docs": patch
---

Fix the `/carpool` "add car" modal failing with an interaction error (and "Sideline didn't respond in time") on English-locale teams. The capacity input reused a 53-character placeholder string as its Discord input label, exceeding Discord's 45-character label limit and getting the whole modal rejected before it could open. The label now uses a dedicated short message key.

Also render the carpool board embed in the Sideline team's configured language (`teams.onboarding_locale`) instead of the Discord guild locale: `CarpoolView` now carries the team `language`, the server populates it from the team row, and `buildCarpoolEmbed` reads it directly.
