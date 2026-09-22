import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS show_attendee_list BOOLEAN NOT NULL DEFAULT true`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS rsvp_reminder_dms BOOLEAN NOT NULL DEFAULT true`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS personal_channels_split BOOLEAN NOT NULL DEFAULT false`,
    ),
  ),
);
