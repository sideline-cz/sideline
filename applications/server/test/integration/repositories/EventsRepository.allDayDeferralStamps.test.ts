// TDD mode — PR 4 of the all-day-Discord-start-time plan (§13.6, §4.8.1, §15.1,
// §7.7f case 8 / §7.12 case 10 of the test spec).
//
// `events.missed_rsvp_counted_at`, `events.all_day_post_sent_at` and
// `team_settings.all_day_post_time` do not exist yet. They must be added by a
// SINGLE migration file `packages/migrations/src/before/<newId>_add_all_day_deferral_stamps.ts`,
// where `<newId>` is strictly greater than the highest existing id at merge
// time (run `ls -1 packages/migrations/src/before/ | sort | tail -1` — do not
// hardcode `1791500000`, which is only a placeholder chosen while PR 3 was
// being written, per the plan's task 0).
//
// The backfill for BOTH new event columns MUST be unconditional (no `WHERE`)
// and in the SAME `UPDATE` statement (§13.6) — a scoped or two-statement
// backfill leaves every pre-existing (or future, if the migration hasn't run
// yet when a flip happens) row armed, and the first cron cycle after deploy
// mass-increments missed-RSVP counters AND mass-posts "Dnes:" for up to a
// week of historical all-day events (§4.8.1, §4.8.3).
//
// This is a Postgres integration test (testcontainers) — column existence,
// NOT NULL/DEFAULT properties, and the backfill's actual effect on seeded
// rows are schema/SQL facts a mock cannot verify.

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { TestPgClient } from '../helpers.js';

describe('migration <newId> — add_all_day_deferral_stamps (PR 4, plan §13.6)', () => {
  it.effect('events.missed_rsvp_counted_at exists as a nullable TIMESTAMPTZ', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'missed_rsvp_counted_at'`,
      );
      expect(cols, 'events.missed_rsvp_counted_at column does not exist').toHaveLength(1);
      expect(cols[0]?.data_type).toBe('timestamp with time zone');
      expect(cols[0]?.is_nullable).toBe('YES');
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('events.all_day_post_sent_at exists as a nullable TIMESTAMPTZ', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'all_day_post_sent_at'`,
      );
      expect(cols, 'events.all_day_post_sent_at column does not exist').toHaveLength(1);
      expect(cols[0]?.data_type).toBe('timestamp with time zone');
      expect(cols[0]?.is_nullable).toBe('YES');
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('team_settings.all_day_post_time exists, is NOT NULL, and defaults to 08:00', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'team_settings' AND column_name = 'all_day_post_time'`,
      );
      expect(cols, 'team_settings.all_day_post_time column does not exist').toHaveLength(1);
      expect(cols[0]?.data_type).toBe('time without time zone');
      expect(cols[0]?.is_nullable).toBe('NO');
      expect(cols[0]?.column_default).toContain('08:00');
    }).pipe(Effect.provide(TestPgClient)),
  );

  // §7.7f case 8 / §7.12 case 10 — the single highest-consequence assertion in
  // this whole PR: the migration's backfill for BOTH new columns must be
  // UNCONDITIONAL (no `WHERE status <> 'active'`, no `WHERE` at all), covering
  // every row that existed before the migration ran — including FUTURE
  // `active` events — or the first cron cycle after deploy mass-increments
  // missed-RSVP counters and mass-posts "Dnes:" for up to a week of
  // historical all-day events (§4.8.1, §4.8.3).
  //
  // RESIDUAL, stated explicitly rather than faked: this per-suite
  // testcontainer runs every migration ONCE at boot (`globalSetup.ts`),
  // before any test data exists — so there is no "pre-existing row" for THIS
  // file to observe the backfill acting on. Asserting it properly requires a
  // dedicated migration-runner test that seeds rows via raw SQL BEFORE
  // running just this migration's exported `Effect` directly (the
  // `packages/migrations/AGENTS.md` "Deep default-importing a migration file
  // for testing" pattern).
  //
  // That test already exists:
  // `applications/server/test/integration/migrations/allDayDeferralStampsBackfill.test.ts`
  // — it deep-imports
  // `@sideline/migrations/before/1791500000_add_all_day_deferral_stamps`
  // directly, seeds active/cancelled/started × all-day/timed × future/past
  // rows via raw SQL, runs the migration's `Effect`, and asserts ZERO
  // unstamped rows remain (no `status` filter) plus idempotence on a second
  // run. If the migration's id is renumbered at merge time (task 0 of PR 4),
  // that file's import path must be updated to match — do not let it silently
  // keep pointing at a stale, never-applied id.
});
