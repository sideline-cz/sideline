---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/web': minor
'@sideline/migrations': patch
'@sideline/i18n': patch
---

Add achievement system: players earn badges for their activity, and selected achievements automatically grant Discord roles.

- Code-defined catalog of 11 V1 achievements covering total activities (1/10/50/100), longest streak (3/7/30 days), cumulative duration (10h/50h), and per-activity-type counts (25 gym / 25 running).
- `AchievementEvaluator` runs after every activity-log create and update; new badges are inserted idempotently and emit a sync event for the bot to process.
- Bot polls `Achievement/GetUnprocessedEvents`, optionally grants a per-team Discord role (5 of 11 achievements), and posts a gold embed to the team's welcome channel.
- Player profile shows an Achievements grid between Roles and Activity Stats; earned badges are highlighted, unearned ones are dimmed.
- New tables: `earned_achievements`, `achievement_role_mappings`, `achievement_sync_events`.
- Fix: `TeamsRepository.insert` now persists `welcome_channel_id` instead of silently dropping it.
