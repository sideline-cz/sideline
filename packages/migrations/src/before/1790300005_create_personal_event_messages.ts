import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS personal_event_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          personal_channel_id TEXT NOT NULL,
          discord_message_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (event_id, team_member_id)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_personal_event_messages_member
          ON personal_event_messages (team_member_id)
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_personal_event_messages_event
          ON personal_event_messages (event_id)
      `,
    ),
  ),
);
