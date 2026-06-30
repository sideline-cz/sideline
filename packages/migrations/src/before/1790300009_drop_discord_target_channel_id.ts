import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE events DROP COLUMN IF EXISTS discord_target_channel_id`),
    Effect.tap(() => sql`ALTER TABLE event_series DROP COLUMN IF EXISTS discord_target_channel_id`),
  ),
);
