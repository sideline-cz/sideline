import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`ALTER TABLE discord_channel_mappings ALTER COLUMN discord_channel_id DROP NOT NULL`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE discord_channel_mappings ADD CONSTRAINT discord_channel_mappings_at_least_one CHECK (discord_channel_id IS NOT NULL OR discord_role_id IS NOT NULL)`,
    ),
    Effect.tap(
      () =>
        sql`CREATE UNIQUE INDEX discord_channel_mappings_team_channel ON discord_channel_mappings (team_id, discord_channel_id) WHERE discord_channel_id IS NOT NULL`,
    ),
  ),
);
