import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE oauth_connections
    ADD COLUMN granted_scopes TEXT NOT NULL DEFAULT ''
  `,
);
