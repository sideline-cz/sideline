import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// The single reminder-DM switch, replaced by the three bucket columns in 1794400000.
// Server v0.78.0 stopped reading and writing it, so no running pod touches it.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`ALTER TABLE team_members DROP COLUMN IF EXISTS rsvp_reminder_dms`,
);
