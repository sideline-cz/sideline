---
"@sideline/server": patch
---

fix: roster member sync events emitted with null discord_user_id

The RSVP and event-roster backfill paths emitted `roster_member_added` /
`roster_member_removed` channel-sync events with a null `discord_user_id`
(they passed `Option.none()` instead of resolving it), while the web
"add to roster" path resolved it correctly. The bot then failed these events
with `EventPropertyMissing` (logged at Error, permanently failed), so affected
members never had their roster Discord role added or removed. Both emit sites
now resolve the member's real `discord_id` from the team-member record at emit
time (matching the working web path), and log a warning if a member cannot be
resolved instead of silently skipping.
