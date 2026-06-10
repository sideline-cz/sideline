import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS event_roster_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          roster_id UUID NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
          team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled')),
          source TEXT NOT NULL CHECK (source IN ('auto','approval')),
          was_member_before BOOLEAN NOT NULL DEFAULT false,
          discord_message_id TEXT,
          decided_by UUID REFERENCES team_members(id) ON DELETE SET NULL,
          decided_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (event_id, team_member_id)
        )
      `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_err_event_status ON event_roster_requests(event_id, status)`,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_err_pending ON event_roster_requests(event_id) WHERE status='pending'`,
    ),
  ),
);
