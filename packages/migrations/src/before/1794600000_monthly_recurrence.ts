import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Monthly recurrence: by date (day_of_month) or by nth weekday (week_of_month + one days_of_week).
// One per-frequency CHECK replaces the inline frequency check and chk_days_of_week.
// Weekly/biweekly keep the old chk_days_of_week rule verbatim and require both new columns NULL,
// so existing rows and an old server's INSERT (which omits the new columns) still pass.
//
// The predicate is wrapped in COALESCE(..., false) because a CHECK passes when it evaluates
// to NULL: without it, e.g. monthly_by_weekday with days_of_week = '{NULL}' would be accepted.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Fail fast instead of blocking boot behind the previous container's event_series queries
    // during the blue-green window (packages/migrations/AGENTS.md, rule 1).
    Effect.tap(() => sql`SET LOCAL lock_timeout = '5s'`),
    Effect.tap(() => sql`ALTER TABLE event_series ADD COLUMN IF NOT EXISTS day_of_month SMALLINT`),
    Effect.tap(() => sql`ALTER TABLE event_series ADD COLUMN IF NOT EXISTS week_of_month SMALLINT`),
    Effect.tap(
      () => sql`ALTER TABLE event_series DROP CONSTRAINT IF EXISTS event_series_frequency_check`,
    ),
    Effect.tap(() => sql`ALTER TABLE event_series DROP CONSTRAINT IF EXISTS chk_days_of_week`),
    Effect.tap(
      () => sql`ALTER TABLE event_series DROP CONSTRAINT IF EXISTS chk_event_series_recurrence`,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE event_series ADD CONSTRAINT chk_event_series_recurrence CHECK (COALESCE(
             (frequency IN ('weekly', 'biweekly')
                AND days_of_week <> '{}' AND array_length(days_of_week, 1) <= 7
                AND day_of_month IS NULL AND week_of_month IS NULL)
          OR (frequency = 'monthly_by_date'
                AND days_of_week = '{}' AND day_of_month BETWEEN 1 AND 31 AND week_of_month IS NULL)
          OR (frequency = 'monthly_by_weekday'
                AND cardinality(days_of_week) = 1 AND days_of_week[1] BETWEEN 0 AND 6
                AND week_of_month IN (1, 2, 3, 4, -1) AND day_of_month IS NULL),
          false))
      `,
    ),
  ),
);
