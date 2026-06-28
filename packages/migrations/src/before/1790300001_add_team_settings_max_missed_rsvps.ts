import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS max_missed_rsvps INT NOT NULL DEFAULT 4`,
    ),
  ),
);
