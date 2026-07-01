---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/migrations": patch
---

feat: re-post events when a team's events channel changes

Changing a team's `discord_events_channel_id` now migrates existing upcoming
events to the new channel instead of leaving them stranded in the old one.
The settings update emits an `event_channel_moved` sync event; the bot
atomically repoints the team's active, future events to the new channel
(nulling their message id as the commit point), deletes the old announcements,
re-posts every now-unposted upcoming event (driven off durable state so a
crashed run recovers on retry), and reorders both channels — the old one's
divider is cleaned up, the new one is capped/ordered by `reorderChannelMessages`.
Also picks up upcoming events that were created while no events channel was
configured (posting was skipped at creation) and posts them into the new
channel.
