import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS all_day BOOLEAN NOT NULL DEFAULT false`,
);
