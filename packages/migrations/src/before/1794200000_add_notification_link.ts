import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) =>
    // Nullable on purpose: the four pre-existing notification types (role/age-group bookkeeping)
    // have nowhere meaningful to navigate to, and backfilling them with a guessed path would
    // send a member to a page that does not explain the row they clicked.
    sql`ALTER TABLE notifications ADD COLUMN link TEXT`,
);
