---
'@sideline/bot': patch
---

Replace the last magic-number button `style:` literal with `Discord.ButtonStyleTypes.DANGER` in the `/sudo` handler, completing the removal of raw button/text-input style numbers across the bot. Behavior-preserving (identical Discord API payload).
