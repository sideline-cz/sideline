import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS event_rosters (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          roster_id UUID NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
          auto_approve BOOLEAN NOT NULL DEFAULT false,
          owners_thread_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (event_id)
        )
      `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX IF NOT EXISTS idx_event_rosters_roster ON event_rosters(roster_id)`,
    ),
  ),
);
