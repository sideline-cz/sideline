import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
        ADD COLUMN IF NOT EXISTS rsvp_reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE
      `,
    ),
  ),
);
