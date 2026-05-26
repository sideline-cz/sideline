import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_global_admin BOOLEAN NOT NULL DEFAULT false
      `,
    ),
  ),
);
