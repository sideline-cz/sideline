---
"@sideline/domain": patch
"@sideline/server": patch
"@sideline/web": patch
"@sideline/i18n": patch
---

fix: add admin tool to backfill members into existing Discord roster roles

Adds an on-demand, team-scoped admin tool to re-sync members into existing
Discord roster roles — for roster members who should hold a role but don't due
to past sync failures. A new team-level "Re-sync roster role members" button on
the rosters list page (gated by `roster:manage`) calls a new
`POST /teams/:teamId/rosters/backfill-role-members` endpoint, which sweeps active
rosters that already have a Discord role and re-emits the idempotent
`roster_channel_created` event to re-add members. A dedup guard excludes rosters
that already have an unprocessed channel sync event, so repeated clicks don't
enqueue duplicates. The sweep is members-only (it does not create missing roles),
batched (limit 50) and returns a `remainingCount` so an admin can click again to
continue. No bot poll loop and no database migration.
