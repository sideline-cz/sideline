import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Splits team_members.rsvp_reminder_dms into one flag per personal-channel bucket
// (training / tournament / other — the same kind mapping as `eventBucketSql`).
//
// The old column stays for one release. The new server writes it as the OR of the three
// buckets and the reminder filter ANDs it in, so an opt-out written by an old server pod
// after this migration ran still silences every bucket.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS rsvp_dms_training BOOLEAN NOT NULL DEFAULT true`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS rsvp_dms_tournament BOOLEAN NOT NULL DEFAULT true`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS rsvp_dms_other BOOLEAN NOT NULL DEFAULT true`,
    ),
    // Carry every deliberate opt-out into all three buckets. Touching only the `false` rows
    // keeps a re-run harmless: a member whose old flag is false has all buckets off anyway.
    Effect.tap(
      () => sql`
        UPDATE team_members
        SET rsvp_dms_training = false, rsvp_dms_tournament = false, rsvp_dms_other = false
        WHERE rsvp_reminder_dms = false
      `,
    ),
  ),
);
