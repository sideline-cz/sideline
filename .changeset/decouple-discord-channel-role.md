---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/web': patch
'@sideline/migrations': patch
'@sideline/i18n': patch
---

Decouple Discord channels from roles for groups. A group's Discord role is now created independently of its channel:

- The role is always created when a group is created (or lazily on first member-add for legacy groups).
- The channel is only created when explicitly requested (settings flag or `Create channel` action).
- Disconnecting a channel keeps the role; re-linking a channel reuses the existing role.
- Deleting a group removes both role and channel.

`channel_sync_events` consolidates provisioning into a single `channel_created` event whose payload carries `Option<channel_name>` to distinguish role-only vs. role + channel paths. `discord_channel_id` is now nullable on the mapping (CHECK constraint enforces at least one of channel/role is set), and a partial unique index prevents two groups from being linked to the same channel. The bot processor splits permanent (Discord 403/404, schema decode) from transient errors so structurally broken events don't poison-pill the queue.
