import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'team:invite'
    FROM roles r
    WHERE r.name = 'Captain' AND r.is_built_in = true
    ON CONFLICT DO NOTHING
  `,
);
