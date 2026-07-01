---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
---

feat: deactivate members when they leave Discord, with membership cascade

When a member leaves (or is kicked/banned from) the Discord guild, the bot now
deactivates their team membership and tears down their memberships: it removes
all their group and roster memberships, revokes their Discord roles / channel
access (via the existing channel-sync outbox), and de-provisions their personal
events channel. The `team_members` row and all history (RSVPs, attendance,
created events) are kept, so the member/history is recoverable on rejoin —
though prior group/roster memberships are not auto-restored (a captain re-adds
them; Discord-role-backed groups return automatically).

The cascade is centralized (`deactivateMemberAndCascade`) and shared by the new
`Guild/RemoveMember` leave path and the existing admin "deactivate member"
endpoint, runs in a single transaction with a per-team advisory lock, and skips
deactivation of the last remaining team manager to avoid orphaning a team.
