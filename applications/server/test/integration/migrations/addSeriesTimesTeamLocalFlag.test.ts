// TDD mode — Release N of the series-time-conversion plan
// (`.work-plans/series-time-conversion.md`, "Release N" §N.1 and
// "Test Specification → Release N" §N.a).
//
// This replaces `seriesTimeIsTeamLocal.test.ts` (deleted in this same change),
// which tested the now-withdrawn `1791600000_series_time_is_team_local.ts`.
// That migration is split in two: this file tests ONLY the first half —
// `1791700000_add_series_times_team_local_flag.ts`, which does nothing but
// `ALTER TABLE event_series ADD COLUMN IF NOT EXISTS times_are_team_local
// BOOLEAN NOT NULL DEFAULT FALSE` — lifted verbatim from `1791600000`. The
// conversion (Statements A and B) is deferred to `1792100000` at Release N+1
// and is NOT exercised here.
//
// `1791700000_add_series_times_team_local_flag.ts` does not exist yet, and
// `packages/migrations` has not been rebuilt to know about it — the deep
// import below is expected to fail module resolution (every test in this
// file errors at load time) until the developer creates that file and runs
// `pnpm build` inside `packages/migrations` (integration tests deep-import
// from `dist`, per the plan's Build Notes). That import failure is the
// correct first shape of "red" for this file — it is not yet a statement
// about the migration's own SQL.
//
// Harness copied from the deleted `seriesTimeIsTeamLocal.test.ts` (itself
// following `anchorAllDayToTeamMidnight.test.ts` / `allDayDeferralStampsBackfill.test.ts`):
// deep default-import of the migration module, `TestPgClient`, a
// `beforeEach(cleanDatabase)`, and raw `INSERT` for the pre-migration row
// shape (no `times_are_team_local` column named) that no repository can
// produce once the column exists.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import addSeriesTimesTeamLocalFlag from '@sideline/migrations/before/1791700000_add_series_times_team_local_flag';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers (mirrors allDayDeferralStampsBackfill.test.ts / the deleted
// seriesTimeIsTeamLocal.test.ts)
// ---------------------------------------------------------------------------

const createUser = (discordId: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username: `user-${discordId.slice(-6)}`,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: string, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Add Series Times Team Local Flag Test Team',
        guild_id: guildId as Discord.Snowflake,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

const setupTeam = (guildId: string) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(guildId)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({
      teamId: team.id as string,
      // TeamMembersRepository.addMember's return type isn't re-exported here;
      // mirrors the `(tm as any).id` cast already used elsewhere for the same call.
      memberId: (member as unknown as { id: string }).id,
    })),
  );

/**
 * Raw INSERT of an `event_series` row WITHOUT naming `times_are_team_local` —
 * exactly the shape every writer produced before this migration existed, and
 * the shape `insertEventSeries` still produces today (Release N never writes
 * the column itself; see the plan's N.1). Column list deliberately omits
 * `times_are_team_local` so the DB default is what's under test.
 */
const insertRawSeriesWithoutFlag = (params: {
  teamId: string;
  createdBy: string;
  startDate: string;
  startTime: string;
  endTime?: string | null;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ id: string }>(`
        INSERT INTO event_series (team_id, title, start_time, end_time, frequency,
                                   days_of_week, start_date, end_date, created_by)
        VALUES (
          '${params.teamId}', 'Weekly Training', '${params.startTime}'::time,
          ${params.endTime == null ? 'NULL' : `'${params.endTime}'::time`},
          'weekly', ARRAY[2], '${params.startDate}'::date, NULL, '${params.createdBy}'
        )
        RETURNING id
      `),
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) throw new Error('insert did not return a row');
      return row.id;
    }),
  );

const readSeriesRow = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{
        start_time: string;
        end_time: string | null;
        times_are_team_local: boolean;
      }>(
        `SELECT start_time::text, end_time::text, times_are_team_local FROM event_series WHERE id = '${id}'`,
      ),
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) throw new Error(`series ${id} not found`);
      return row;
    }),
  );

/** Runs the migration's own Effect against the test database. Safe to reference more than
 * once in the same chain — each reference is a fresh execution, exactly like an operator
 * re-running the migration by hand (the `testing` environment's actual situation, per the
 * plan: `1791600000` already added this column there, so `1791700000` is a pure no-op). */
const runMigration = () => addSeriesTimesTeamLocalFlag;

/**
 * Fix 4 (review): the integration DB is bootstrapped by running the FULL migration set,
 * including this one, before any test's own `beforeEach(cleanDatabase)` — which truncates
 * ROWS, not columns. So by the time test 1 below calls `runMigration()`, the column this
 * migration is supposed to ADD already exists, and "adds the column" was, until this fix,
 * silently exercising the `IF NOT EXISTS` no-op path (test 3's actual subject), not the ADD
 * path its own name claims. Dropping the column first makes test 1 genuinely cover ADD.
 */
const dropTimesAreTeamLocalColumn = () =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql`ALTER TABLE event_series DROP COLUMN IF EXISTS times_are_team_local`,
    ),
  );

describe('migration 1791700000 — adds event_series.times_are_team_local, converts nothing', () => {
  it.effect('1. adds the column, defaulting FALSE for a row inserted without naming it', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () => setupTeam('960200000000000001')),
      // The integration DB is bootstrapped with this migration already applied — drop the
      // column first so this test genuinely exercises ADD, not IF NOT EXISTS's no-op path.
      Effect.tap(() => dropTimesAreTeamLocalColumn()),
      Effect.tap(() => runMigration()),
      Effect.bind('seriesId', ({ setup }) =>
        insertRawSeriesWithoutFlag({
          teamId: setup.teamId,
          createdBy: setup.memberId,
          startDate: '2026-01-06',
          startTime: '17:00:00',
        }),
      ),
      Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(row.times_are_team_local).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    "2. does NOT touch times — a '17:00' start_time seeded BEFORE the migration runs is still " +
      "exactly '17:00:00' afterward. This is the test that catches someone folding the " +
      'conversion (deferred to 1792100000) back into this release early.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('960200000000000002')),
        // Seed BEFORE the column (and therefore before any possible conversion
        // logic) exists — the pre-migration shape.
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeriesWithoutFlag({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
            endTime: '19:00:00',
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            // NOT '18:00:00' — that would be Statement A's conversion, which
            // belongs to 1792100000 (Release N+1), not this migration.
            expect(row.start_time).toBe('17:00:00');
            expect(row.end_time).toBe('19:00:00');
            expect(row.times_are_team_local).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    '3. idempotent — running it twice is a no-op the second time (ADD COLUMN IF NOT EXISTS), ' +
      "matching the `testing` environment's situation where the withdrawn 1791600000 already " +
      'added this column',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('960200000000000003')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeriesWithoutFlag({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('afterFirstRun', ({ seriesId }) => readSeriesRow(seriesId)),
        // Must not throw ("column already exists") and must not change the row.
        Effect.tap(() => runMigration()),
        Effect.bind('afterSecondRun', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.tap(({ afterFirstRun, afterSecondRun }) =>
          Effect.sync(() => {
            expect(afterSecondRun).toEqual(afterFirstRun);
            expect(afterSecondRun.times_are_team_local).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
