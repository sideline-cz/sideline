import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE teams
        ADD COLUMN IF NOT EXISTS achievement_channel_id TEXT
      `,
    ),
    Effect.tap(
      () => sql`
        UPDATE teams
        SET achievement_channel_id = welcome_channel_id
        WHERE achievement_channel_id IS NULL
      `,
    ),
  ),
);
