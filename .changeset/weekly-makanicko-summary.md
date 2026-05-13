---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/web': minor
'@sideline/migrations': patch
---

Add weekly makáníčko summaries: teams receive an automated weekly recap every Sunday ~20:00 local team time, posted to a configured Discord channel, with a captain-only web page mirroring the data.

- New `WeeklySummary` domain models (`WeekRange`, `PlayerWeeklySummary`, `TeamWeeklySummary`, `WeeklySummaryResponse`, `WeeklySummaryDigest`) plus `WeeklySummaryApi` HTTP group and `WeeklySummaryRpcGroup` (`Get/Mark` outbox RPCs).
- New `team_settings.weekly_summary_channel_id` column and `weekly_summary_sync_events` outbox table with `UNIQUE (team_id, week_start)` so cron inserts are idempotent (`ON CONFLICT DO NOTHING`).
- Server: `WeeklySummaryRepository` (week-scoped activity, achievement, and active-member queries), `WeeklySummarySyncEventsRepository` (outbox with `delivered_at` separate from `processed_at`, attempt-capped retry), `WeeklySummaryService` (`buildPlayerSummary`, `buildTeamSummary`), `WeeklySummaryHandler` (HTTP API gated on team membership; team section requires `roster:manage`), `WeeklySummaryCron` (per-minute, timezone-aware Sunday 20:00 firing with `Effect.exit` per team, `concurrency: 1`).
- Bot: `buildWeeklySummaryEmbed` (team channel embed with empty-state, top contributors, week-over-week delta), `handleWeeklySummaryReady`, polling `ProcessorService`.
- Web: `WeeklySummaryPage` with player + team sections (coach-only) and ISO week navigation (handles W53 long years), new `workout.weekly.tsx` route, link from `MakanickoPage`.
- Tests: 47 new unit tests across domain + server + bot. Integration repo test scaffolded (`.skip`) pending Pg testcontainer wiring.

MVP boundaries: channel-only delivery, single team embed; per-player DMs, "didn't log this week" callouts, and player rank deferred to v2.
