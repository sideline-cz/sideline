import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      INSERT INTO role_permissions (role_id, permission)
      SELECT id, 'challenge:manage' FROM roles WHERE is_built_in = true AND name IN ('Admin', 'Captain')
      ON CONFLICT DO NOTHING
    `,
    ),
  ),
);
