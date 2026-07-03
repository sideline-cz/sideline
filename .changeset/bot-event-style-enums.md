---
'@sideline/bot': patch
---

Replace magic-number button `style:` literals with the `Discord.ButtonStyleTypes` enum across the `rest/events/*` embed/message builders (buildEventEmbed, buildEventListEmbed, buildClaimMessage, buildAttendeesEmbed, buildRosterApprovalMessage), matching the existing buildUpcomingEventEmbed convention. Behavior-preserving (identical Discord API payload).
