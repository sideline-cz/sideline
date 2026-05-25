import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Rename tables
    Effect.tap(() => sql`ALTER TABLE weekly_challenges RENAME TO team_challenges`),
    Effect.tap(
      () => sql`ALTER TABLE weekly_challenge_completions RENAME TO team_challenge_completions`,
    ),
    Effect.tap(
      () => sql`ALTER TABLE weekly_challenge_sync_events RENAME TO team_challenge_sync_events`,
    ),

    // Rename week_start_date to start_date
    Effect.tap(() => sql`ALTER TABLE team_challenges RENAME COLUMN week_start_date TO start_date`),

    // Add end_date column, backfill from start_date + 6 days, set NOT NULL
    Effect.tap(() => sql`ALTER TABLE team_challenges ADD COLUMN end_date DATE`),
    Effect.tap(
      () =>
        sql`UPDATE team_challenges SET end_date = start_date + INTERVAL '6 days' WHERE end_date IS NULL`,
    ),
    Effect.tap(() => sql`ALTER TABLE team_challenges ALTER COLUMN end_date SET NOT NULL`),

    // Drop the Monday-only CHECK constraint (auto-named by Postgres from original CREATE TABLE)
    Effect.tap(
      () => sql`
      DO $$
      DECLARE
        con_name TEXT;
      BEGIN
        SELECT conname INTO con_name
        FROM pg_constraint
        WHERE conrelid = 'team_challenges'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%ISODOW%';
        IF con_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE team_challenges DROP CONSTRAINT %I', con_name);
        END IF;
      END;
      $$
    `,
    ),

    // Drop the UNIQUE (team_id, start_date) constraint — overlap now allowed
    Effect.tap(
      () => sql`
      DO $$
      DECLARE
        con_name TEXT;
      BEGIN
        SELECT conname INTO con_name
        FROM pg_constraint
        WHERE conrelid = 'team_challenges'::regclass
          AND contype = 'u';
        IF con_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE team_challenges DROP CONSTRAINT %I', con_name);
        END IF;
      END;
      $$
    `,
    ),

    // Add CHECK constraint: start_date <= end_date
    Effect.tap(
      () =>
        sql`ALTER TABLE team_challenges ADD CONSTRAINT team_challenges_date_range_check CHECK (start_date <= end_date)`,
    ),

    // Rename indexes
    Effect.tap(
      () => sql`ALTER INDEX IF EXISTS idx_weekly_challenges_team_week RENAME TO idx_tc_team_start`,
    ),
    Effect.tap(
      () => sql`ALTER INDEX IF EXISTS idx_weekly_challenge_sync_events_due RENAME TO idx_tcse_due`,
    ),
  ),
);
