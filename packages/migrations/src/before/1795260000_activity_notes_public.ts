import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Team-wide switch that lets teammates read each other's activity-log notes.
// NOT NULL DEFAULT false: off is the current behaviour (a note is private to its author), so
// every existing row is already correct and the deploy is a no-op.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.tap(
    Effect.void,
    () => sql`
      ALTER TABLE team_settings
        ADD COLUMN IF NOT EXISTS activity_notes_public BOOLEAN NOT NULL DEFAULT false
    `,
  ),
);
