import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * `team_settings.timezone` was free-form `TEXT`. The HTTP path validates it
 * with `isValidIanaTimezone`, but a migration, seed or operator write could
 * still store garbage — and `AT TIME ZONE '<garbage>'` raises, so one bad row
 * broke every reader of that column, fleet-wide, not just its own team's.
 *
 * The sanitize MUST precede the constraint: `ADD CONSTRAINT` evaluates the
 * expression against existing rows, and on a bad row it aborts with
 * `time zone "..." not recognized`. `MigrateBefore` runs inside server boot
 * (`applications/server/src/run.ts`), so that failure means the container
 * never starts. `'Europe/Prague'` is the column default and the documented
 * fallback (`packages/migrations/AGENTS.md`).
 *
 * The CHECK is deliberately weaker than the sanitize: `AT TIME ZONE` also
 * accepts abbreviations and POSIX offsets (`EST`, `UTC+3`) that are absent
 * from `pg_timezone_names`, and a CHECK cannot contain the subquery needed to
 * demand a canonical IANA name. It rejects what actually breaks readers.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        UPDATE team_settings
        SET timezone = 'Europe/Prague'
        WHERE timezone NOT IN (SELECT name FROM pg_timezone_names)
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          DROP CONSTRAINT IF EXISTS team_settings_timezone_check
      `,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE team_settings
          ADD CONSTRAINT team_settings_timezone_check
          CHECK (now() AT TIME ZONE timezone IS NOT NULL)
      `,
    ),
  ),
);
