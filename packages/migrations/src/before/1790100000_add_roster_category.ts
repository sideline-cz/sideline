import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE team_settings ADD COLUMN discord_roster_category_id TEXT`),
    Effect.tap(() => sql`ALTER TABLE channel_sync_events ADD COLUMN target_category_id TEXT`),
  ),
);
