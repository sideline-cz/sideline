---
'@sideline/bot': patch
---

Replace magic-number button `style:` literals with the `Discord.ButtonStyleTypes` enum across the `rest/` poll, email, and carpool builders (buildPollEmbed, buildPollPrivateView, buildEmailEmbeds, buildCarpoolEmbed), including the ternary-derived styles. Behavior-preserving (identical Discord API payload).
