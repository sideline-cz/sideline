---
"@sideline/domain": patch
"@sideline/migrations": patch
"@sideline/server": patch
"@sideline/bot": patch
"@sideline/web": patch
"@sideline/i18n": patch
---

fix: add a per-team Discord category for new roster channels

Teams can now choose a Discord category under which new roster channels are
created, configured on the Team Settings page (mirrors the existing archive
category). When a deactivated roster is reactivated, its channel is re-created
in that category. The bot applies the category as `parent_id` on channel
creation; if the category is stale or deleted (permanent Discord error) it
falls back to creating the channel at the guild root, while transient errors
retry with the category intact. Persisted via a new `discord_roster_category_id`
column on `team_settings` and carried to the bot through a dedicated
`target_category_id` on the roster channel-created event.
