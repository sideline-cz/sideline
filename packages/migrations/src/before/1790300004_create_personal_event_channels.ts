import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS personal_event_channels (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
          discord_channel_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (team_id, team_member_id)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_event_channels_discord_channel
          ON personal_event_channels (discord_channel_id)
          WHERE discord_channel_id IS NOT NULL
      `,
    ),
  ),
);
