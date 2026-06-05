import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_team_channels_discord_channel
        ON team_channels(team_id, discord_channel_id) WHERE discord_channel_id IS NOT NULL
    `,
    ),
  ),
);
