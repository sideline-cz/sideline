import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS global_admin_granted_at TIMESTAMPTZ
      `,
    ),
    Effect.tap(
      () => sql`
        UPDATE users SET global_admin_granted_at = now() WHERE is_global_admin = true AND global_admin_granted_at IS NULL
      `,
    ),
  ),
);
