---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/web': minor
'@sideline/migrations': patch
'@sideline/i18n': patch
---

Add admin achievement management: captains can override built-in thresholds, create custom achievements, map achievements to Discord roles (existing or auto-created), and preview qualification impact before saving.

- New admin page at `/teams/:teamId/achievements` (gated by `team:manage`).
- Per-team threshold overrides for the 11 built-in achievements via new `achievement_settings` table; `AchievementEvaluator` applies overrides at evaluation time without disturbing the closure-based catalog.
- New `custom_achievements` table for admin-created achievements (CRUD-only — evaluation/role-granting for customs is a follow-up).
- Auto-create Discord role flow uses a separate idempotent outbox table (`discord_role_provision_events`) with attempt-based retry; bot reuses same-named existing roles to avoid duplicates.
- Preview endpoint reports qualifying count, sample of soon-to-be-disqualified players, and whether the bot has Manage Roles permission.
- `AchievementSlug` stays a closed literal; player-facing `AchievementsGrid` is untouched.
