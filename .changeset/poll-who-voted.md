---
"@sideline/bot": minor
"@sideline/server": minor
"@sideline/domain": minor
"@sideline/i18n": patch
"@sideline/docs": patch
---

Add a "Who voted?" button to the `/poll` public board

Members can now click **👥 Who voted?** on a poll (open or closed) to get an ephemeral message listing each option with the people who voted for it, rendered as `Name (@mention)` without pinging anyone. Backed by a new `Poll/GetPollVoters` RPC and a team-scoped `findPollVoters` query that returns the true per-option vote counts (the displayed voter list is capped at 60 per option, with the remainder shown as "…and N more"). Voter identities are visible to all team members.
