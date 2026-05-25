import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE weekly_challenges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        week_start_date DATE NOT NULL CHECK (EXTRACT(ISODOW FROM week_start_date) = 1),
        kind TEXT NOT NULL CHECK (kind IN ('throwing','sport')),
        title VARCHAR(120) NOT NULL CHECK (char_length(title) >= 1),
        description VARCHAR(2000),
        created_by UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (team_id, week_start_date)
      )
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE weekly_challenge_completions (
        challenge_id UUID NOT NULL REFERENCES weekly_challenges(id) ON DELETE CASCADE,
        member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (challenge_id, member_id)
      )
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TABLE weekly_challenge_sync_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        challenge_id UUID NOT NULL REFERENCES weekly_challenges(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        scheduled_for TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ
      )
    `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_weekly_challenges_team_week ON weekly_challenges (team_id, week_start_date DESC)`,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_weekly_challenge_sync_events_due ON weekly_challenge_sync_events (team_id, scheduled_for) WHERE processed_at IS NULL`,
    ),
  ),
);
