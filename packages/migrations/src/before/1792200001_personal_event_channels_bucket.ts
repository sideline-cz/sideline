import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // 1. Column. Every existing row becomes 'all' = the combined channel it already is.
    Effect.tap(
      () =>
        sql`ALTER TABLE personal_event_channels ADD COLUMN IF NOT EXISTS bucket TEXT NOT NULL DEFAULT 'all'`,
    ),
    // 2. Value guard.
    Effect.tap(
      () => sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personal_event_channels_bucket_valid') THEN
            ALTER TABLE personal_event_channels ADD CONSTRAINT personal_event_channels_bucket_valid
              CHECK (bucket IN ('all','training','tournament','other'));
          END IF;
        END $$
      `,
    ),
    // 3. Widen uniqueness BEFORE dropping the old one, so the table is never unprotected.
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_event_channels_member_bucket
          ON personal_event_channels (team_id, team_member_id, bucket)
      `,
    ),
    // 4. Drop the inline CREATE TABLE constraint (Postgres' generated name).
    //    See design plan §12/S2 — this breaks OLD server pods' ON CONFLICT clause for the
    //    rollout window. Deploy server before bot; expect a provisioning gap.
    Effect.tap(
      () => sql`
        ALTER TABLE personal_event_channels
          DROP CONSTRAINT IF EXISTS personal_event_channels_team_id_team_member_id_key
      `,
    ),
  ),
);
