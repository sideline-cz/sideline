import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * The scheduled rules quiz: a team can nominate a channel and have the bot
 * post one situation there every N days at a local time.
 *
 * ⚠️ **Named `rules_quiz_*`, never `rules_*`.** `teams.rules_channel_id`
 * already exists and means something completely different — the onboarding
 * code-of-conduct channel that Discord's onboarding prompt gates access to
 * (see `applications/bot/src/rcp/onboarding/`). Reusing the `rules_` prefix
 * here would put two unrelated features one grep apart, and the older one is
 * the one people find first.
 *
 * `rules_quiz_channel_id IS NULL` means the feature is off. That is the
 * default for every existing team: nominating a channel is the whole opt-in,
 * so no team starts posting because of this migration.
 *
 * `rules_quiz_time` is `HH:MM` TEXT interpreted in the team's own
 * `team_settings.timezone`, matching `rsvp_reminder_time` exactly rather than
 * inventing a second convention. Per `applications/web/AGENTS.md`'s
 * team-scoped-date rules, the cron resolves it against the team timezone, not
 * the server's — a bug of that class only shows up for teams whose timezone
 * differs from the host's, and only at the boundary.
 *
 * **`UNIQUE (team_id, scheduled_for)` is the idempotency guard**, mirroring
 * `weekly_summary_sync_events`' `UNIQUE (team_id, week_start)`. The cron ticks
 * every minute and its "is it time?" check spans a 60-second window, so
 * without this a slow tick or an overlapping run could post the same situation
 * twice. The insert is `ON CONFLICT DO NOTHING`, which makes a double-tick a
 * no-op rather than an error.
 *
 * There is deliberately no `last_posted_at` column: "N days since the last
 * one" is derived from `MAX(scheduled_for)` in this table, so the schedule has
 * exactly one source of truth and no write path that can drift from the audit
 * trail.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD COLUMN IF NOT EXISTS rules_quiz_channel_id TEXT,
          ADD COLUMN IF NOT EXISTS rules_quiz_interval_days INT NOT NULL DEFAULT 7,
          ADD COLUMN IF NOT EXISTS rules_quiz_time TEXT NOT NULL DEFAULT '18:00'
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD CONSTRAINT team_settings_rules_quiz_interval_days_check
          CHECK (rules_quiz_interval_days >= 1 AND rules_quiz_interval_days <= 90)
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS rules_quiz_sync_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          channel_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          scheduled_for TIMESTAMPTZ NOT NULL,
          attempts INT NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at TIMESTAMPTZ,
          UNIQUE (team_id, scheduled_for)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX idx_rqse_pending ON rules_quiz_sync_events(team_id, scheduled_for)
        WHERE processed_at IS NULL
      `,
    ),
  ),
);
