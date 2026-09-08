import { PgClient } from '@effect/sql-pg';
import { Config, Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

const TestPgClientConfig = {
  host: Config.string('DATABASE_HOST'),
  port: Config.number('DATABASE_PORT'),
  database: Config.string('DATABASE_NAME'),
  username: Config.string('DATABASE_USER'),
  password: Config.redacted('DATABASE_PASS'),
};

export const TestPgClient = PgClient.layerConfig(TestPgClientConfig);

/**
 * Empties every public table that actually holds rows, in a single `TRUNCATE`.
 *
 * This runs in `beforeEach` across 62 files and 617 tests, so its cost is paid
 * once per test and used to dominate the whole integration suite. It was slow
 * for two independent reasons:
 *
 * - **One `TRUNCATE` per table.** 85 separate commands, each taking its own
 *   `ACCESS EXCLUSIVE` lock, and `CASCADE` re-truncating tables the loop was
 *   going to reach on its own anyway.
 * - **Truncating all 85 whatever their contents.** A test dirties a handful;
 *   truncating an already-empty table is not free.
 *
 * Probing with `EXISTS` first is exact — unlike `pg_class.reltuples`, which is
 * a planner estimate and goes stale — and leaves precisely the same end state,
 * because a table with no rows is already what truncating it would produce.
 * Neither this nor the version it replaced resets sequences.
 *
 * Measured against the real schema, per clean (`postgres:17`, 85 tables, one
 * table dirtied):
 *
 * | per-table loop      | 480ms |
 * | one multi-table cmd |  63ms |
 * | probe then truncate |   4ms |
 *
 * The margin matters beyond the ~5 minutes it saves per run: at 480ms this
 * hook was the thing that blew `hookTimeout` under load, and because it runs
 * before *every* test, whichever test happened to be next got the blame. That
 * produced a different unrelated failure each run and cost a previous session
 * three runs to tell apart from a real bug.
 */
export const cleanDatabase = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen((sql) =>
    sql.unsafe(`
      DO $$
      DECLARE
        r RECORD;
        dirty text[] := '{}';
        has_rows boolean;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'migrations_%')
        LOOP
          EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)', r.tablename) INTO has_rows;
          IF has_rows THEN
            dirty := dirty || quote_ident(r.tablename);
          END IF;
        END LOOP;
        IF array_length(dirty, 1) > 0 THEN
          EXECUTE 'TRUNCATE TABLE ' || array_to_string(dirty, ', ') || ' CASCADE';
        END IF;
      END $$;
    `),
  ),
  Effect.asVoid,
);
