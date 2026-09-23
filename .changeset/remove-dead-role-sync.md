---
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/domain': minor
'@sideline/migrations': minor
'@sideline/i18n': minor
---

Remove the dead Sideline-role to Discord-role sync subsystem

A Sideline role is a permissions construct and no longer produces a Discord guild role; #715 made the sync inert and this removes what was left of it. Gone: the `role_sync_events` outbox and its bot worker, the `discord_role_mappings` and `member_role_grants` tables, the `team_members.last_role_sync_*` columns, the three role-diff utils, the `Role/*` RPC group, and the `syncMemberDiscordRoles` endpoint.

Discord roles continue to come from groups and rosters (`channel_sync_events`) and from achievements (`role_provision_events`), neither of which is affected. Guild roles created by the old behaviour are left in customer guilds untouched.
