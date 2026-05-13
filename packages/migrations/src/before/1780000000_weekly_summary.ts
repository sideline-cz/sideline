import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS weekly_summary_channel_id TEXT
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS weekly_summary_sync_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          week_start TIMESTAMPTZ NOT NULL,
          week_end TIMESTAMPTZ NOT NULL,
          channel_id TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}',
          attempts INT NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at TIMESTAMPTZ,
          delivered_at TIMESTAMPTZ,
          UNIQUE (team_id, week_start)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX idx_wsse_pending ON weekly_summary_sync_events(team_id, week_start)
        WHERE processed_at IS NULL
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX idx_wsse_delivered ON weekly_summary_sync_events(team_id, week_start)
        WHERE delivered_at IS NOT NULL
      `,
    ),
  ),
);
