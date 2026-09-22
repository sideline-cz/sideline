// TDD mode — Release N+1 of the two-release series-time conversion split
// (`.work-plans/series-time-conversion.md`, §A "The three statements" and
// §F "Test specification"). This tests `1792100000_series_time_is_team_local`,
// the deferred conversion migration that Release N's
// `1791700000_add_series_times_team_local_flag.ts` only reserved a column for.
//
// The plan survived one adversarial review that returned BLOCK with two
// blockers, both re-verified independently against real Postgres before this
// file was written (see the inline notes on B15 and B8/B11/B12 below):
//
//   - Blocker 1: `idx_events_series_date` (a non-deferrable unique index on
//     `(series_id, (start_at AT TIME ZONE 'UTC')::date)`,
//     `1741800000_event_datetime_columns.ts:24`) makes Statement B's `UPDATE`
//     abort mid-statement for any series whose occurrences shift UTC date
//     FORWARD. The migration must bracket Statement B with `DROP INDEX` /
//     `CREATE UNIQUE INDEX`. Test B15 reproduces this with a real
//     four-occurrence west-of-UTC series; it was confirmed to fail with the
//     bracket removed and pass with it in place. Shift direction is what
//     decides, NOT physical row order — see B15's own comment.
//   - Blocker 2: three of the plan's original Statement B fixtures were dated
//     in the past, so B's `start_at >= now()` guard silently excluded them —
//     they never ran. All Statement B fixtures below are dated 2027 and, where
//     the case is about a DST boundary, anchored across it — see B8/B11/B12.
//
// ⚠️ RUN `pnpm build` (or at least `pnpm --filter @sideline/migrations build`)
// BEFORE RUNNING THIS SUITE, AFTER EVERY EDIT TO THE MIGRATION. The deep
// import below resolves through `applications/server/node_modules/@sideline/
// migrations -> packages/migrations/dist`, so this suite exercises the
// COMPILED artifact (`dist/dist/esm/before/...js`), never `src/`. Editing the
// migration and re-running the tests without rebuilding silently tests the
// PREVIOUS version of the SQL.
//
// This is not hypothetical: it is what produced the "DO NOT MERGE, blocker
// unfixed" state of commit 65a1a9ef, where B15 failed with a duplicate-key
// error and Postgres's own statement log showed the migration's `DROP INDEX`
// never executing — because the `dist` being loaded predated it. Note that
// `dist/src/` is a COPY OF THE TYPESCRIPT SOURCE, not build output: comparing
// `dist/src` against `src` always matches and proves nothing about staleness.
// Check `dist/dist/esm/before/<migration>.js` instead.
//
// Statement C ("flip the column default") was CUT during review — see the
// plan's status header and §A. There is no C1–C3 here; do not add them back.
// Cross-cutting case X1 ("rows unchanged after a rolled-back transaction")
// was also cut by the plan itself as vacuous (it tests Effect's
// `sql.withTransaction` and Postgres's transactional DDL, not this
// migration's own SQL) — omitted here for the same reason.
//
// SCHEMA DISAGREEMENT WITH THE PLAN'S OWN A4/A5 FIXTURES — found while
// writing this file, verified against `sideline-postgres-1`:
// `1792000005_team_settings_timezone_check.ts` (already on `origin/main`,
// already applied by the time this suite's `globalSetup.ts` runs the full
// migration set) added `CHECK (now() AT TIME ZONE timezone IS NOT NULL)` to
// `team_settings`. Postgres evaluates that `AT TIME ZONE` expression eagerly
// on every INSERT/UPDATE, so `team_settings.timezone = 'Mars/Olympus'` or
// `''` — the plan's literal A4/A5 fixtures — now raise
// `22023 time zone "..." not recognized` AT SEED TIME, through
// `TeamSettingsRepository.upsert` *and* through a raw `sql.unsafe` INSERT
// alike (it is a real Postgres CHECK, not an application-layer guard). There
// is no way to get such a row into `team_settings` any more. That does not
// make Statement A's `JOIN pg_timezone_names` defence dead code, though: the
// plan's own §C4 names the still-reachable class — `'EST'`, `'UTC+3'` — POSIX
// zone abbreviations/offsets that Postgres's `AT TIME ZONE` accepts (so they
// pass the CHECK) but that are NOT rows in `pg_timezone_names` (so Statement
// A's join still excludes them and falls back). A4/A5 below use `'EST'` and
// `'UTC+3'` instead of `'Mars/Olympus'`/`''`, both independently confirmed by
// hand against `sideline-postgres-1`:
//   INSERT ... VALUES (..., 'Mars/Olympus') -- ERROR 22023, blocked by the CHECK
//   INSERT ... VALUES (..., 'EST')          -- succeeds; NOT IN pg_timezone_names
//   INSERT ... VALUES (..., 'UTC+3')        -- succeeds; NOT IN pg_timezone_names
//
// The task brief's "NULL timezone" case is the same case as A3 ("no
// `team_settings` row"): `team_settings.timezone` is `TEXT NOT NULL`, so the
// column itself can never hold SQL NULL — what goes NULL is the correlated
// subselect's RESULT when no `team_settings` row exists for the team, which
// `COALESCE` then catches. A3 already covers that; there is no separate
// "NULL timezone" fixture here.
//
// The plan's §F test table reuses the id "B15" for two different cases (the
// index-collision case and the "no team_settings row, Statement B side"
// case). The second is renumbered B16 below to keep ids unique; flagged in
// the tester report.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import seriesTimeIsTeamLocal from '@sideline/migrations/before/1792100000_series_time_is_team_local';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamMembersRepository.Default,
  TeamSettingsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers (copied from the withdrawn `0897f9a1:.../seriesTimeIsTeamLocal.test.ts`,
// plus the two harness additions the plan's §F calls for: `insertRawSeries`
// gains `timesAreTeamLocal?: boolean` and `status?: string`)
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
        name: 'Series Time Conversion Test Team',
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

const setTeamTimezone = (teamId: Team.TeamId, timezone: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 14,
        minPlayersThreshold: 0,
        timezone,
      }),
    ),
  );

/**
 * Creates a user + team + team member, and OPTIONALLY a `team_settings` row.
 * Passing `timezone: undefined` leaves the team WITHOUT a `team_settings` row
 * at all (A3/B16). Any other string is written through
 * `TeamSettingsRepository.upsert`, which performs no application-layer
 * timezone validation — only `team_settings_timezone_check`'s Postgres CHECK
 * does (see the file header re: A4/A5).
 */
const setupTeam = (guildId: string, timezone?: string) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(guildId)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.tap(({ team }) =>
      timezone === undefined ? Effect.void : setTeamTimezone(team.id, timezone),
    ),
    Effect.map(({ team, member }) => ({
      teamId: team.id as string,
      memberId: (member as unknown as { id: string }).id,
    })),
  );

/**
 * Raw INSERT of an `event_series` row, bypassing `EventSeriesRepository`
 * entirely — this migration's whole job is converting rows that predate its
 * `times_are_team_local = TRUE` semantics, which nothing written through the
 * repository (post-#650) can produce for a `FALSE` row.
 *
 * `timesAreTeamLocal` defaults to omitted (column default `FALSE`, from
 * `1791700000`), matching every legacy row. A11/B7 pass `true` explicitly to
 * seed a row that was NEVER meant to be touched by this migration.
 */
const insertRawSeries = (params: {
  teamId: string;
  createdBy: string;
  startDate: string;
  startTime: string;
  endTime?: string | null;
  status?: string;
  timesAreTeamLocal?: boolean;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ id: string }>(`
        INSERT INTO event_series (team_id, title, start_time, end_time, frequency,
                                   days_of_week, start_date, end_date, status, created_by
                                   ${params.timesAreTeamLocal === undefined ? '' : ', times_are_team_local'})
        VALUES (
          '${params.teamId}', 'Weekly Training', '${params.startTime}'::time,
          ${params.endTime == null ? 'NULL' : `'${params.endTime}'::time`},
          'weekly', ARRAY[2], '${params.startDate}'::date, NULL,
          '${params.status ?? 'active'}', '${params.createdBy}'
          ${params.timesAreTeamLocal === undefined ? '' : `, ${params.timesAreTeamLocal}`}
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

/** Raw INSERT of an `events` row generated FROM a series, bypassing `EventsRepository`. */
const insertRawSeriesEvent = (params: {
  teamId: string;
  createdBy: string;
  seriesId: string | null;
  startAtIso: string;
  endAtIso?: string | null;
  seriesModified?: boolean;
  status?: string;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ id: string }>(`
        INSERT INTO events (team_id, event_type, title, start_at, end_at, created_by,
                             series_id, series_modified, status)
        VALUES (
          '${params.teamId}', 'training', 'Weekly Training',
          '${params.startAtIso}'::timestamptz,
          ${params.endAtIso == null ? 'NULL' : `'${params.endAtIso}'::timestamptz`},
          '${params.createdBy}',
          ${params.seriesId == null ? 'NULL' : `'${params.seriesId}'`},
          ${params.seriesModified ?? false},
          '${params.status ?? 'active'}'
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

const readEventRow = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{
        start_at: Date;
        end_at: Date | null;
        personal_messages_dirty_at: Date | null;
      }>(`SELECT start_at, end_at, personal_messages_dirty_at FROM events WHERE id = '${id}'`),
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) throw new Error(`event ${id} not found`);
      return {
        startAtIso: row.start_at.toISOString(),
        endAtIso: row.end_at === null ? null : row.end_at.toISOString(),
        personalMessagesDirtyAt: row.personal_messages_dirty_at,
      };
    }),
  );

/** Runs the migration's own Effect against the test database. Safe to reference more than
 * once in the same chain — each reference is a fresh execution, exactly like an operator
 * re-running the migration by hand. */
const runMigration = () => seriesTimeIsTeamLocal;

describe('migration 1792100000 — converts series times to team-local wall clock, re-anchors future occurrences', () => {
  // =========================================================================
  // Statement A
  // =========================================================================
  describe('Statement A — converts event_series.start_time/end_time, sets times_are_team_local', () => {
    it.effect(
      'A1. happy path — Prague winter series, 17:00 UTC-dialect becomes 18:00 team-local',
      // Catches: Statement A deleted entirely, or the two `AT TIME ZONE`
      // operands swapped (would give 16:00 instead of 18:00).
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000001', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('18:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A2. IDEMPOTENCE — running the migration TWICE shifts 17:00 to 18:00 exactly ONCE',
      // Catches: `WHERE NOT es.times_are_team_local` missing, or the flag set
      // in a separate statement from the value write. The single most
      // important case in this file.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000002', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              endTime: '19:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('afterFirstRun', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ afterFirstRun }) =>
            Effect.sync(() => {
              expect(afterFirstRun.start_time).toBe('18:00:00');
              expect(afterFirstRun.end_time).toBe('20:00:00');
              expect(afterFirstRun.times_are_team_local).toBe(true);
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('afterSecondRun', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ afterFirstRun, afterSecondRun }) =>
            Effect.sync(() => {
              // NOT '19:00:00'/'21:00:00' — a second shift would mean the
              // guard is broken.
              expect(afterSecondRun).toEqual(afterFirstRun);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A3. no team_settings row — falls back to Europe/Prague via COALESCE, not an inner join',
      // Catches: `UPDATE ... FROM team_settings` (an inner join), which would
      // silently skip this row and leave it FALSE/17:00 forever.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000003')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('18:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      "A4. unrecognised zone accepted by team_settings' own CHECK ('EST') does not abort the migration",
      // `'Mars/Olympus'`/`''` (the plan's original fixtures) can no longer be
      // stored in `team_settings.timezone` at all — see the file header.
      // `'EST'` passes `team_settings_timezone_check` (Postgres's `AT TIME
      // ZONE` accepts POSIX abbreviations) but is NOT a row in
      // `pg_timezone_names`, so it still exercises Statement A's join-based
      // defence. Catches: the join dropped, leaving a bare `COALESCE` that
      // only catches NULL — `AT TIME ZONE 'EST'` would then just resolve
      // silently to whatever it means (a US-eastern-standard-time
      // interpretation, not the fallback), giving the WRONG answer rather
      // than raising, which this test tells apart from the correct fallback.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000004', 'EST')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          // The whole point of this case: must not throw and must not abort.
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              // Europe/Prague fallback, same as A1/A3.
              expect(row.start_time).toBe('18:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      "A5. a second, differently-shaped unrecognised zone ('UTC+3') — same defence, different parse shape",
      // A distinct fixture from A4 (a POSIX numeric offset rather than an
      // abbreviation) so a fix that special-cases one string shape but not
      // the other is still caught.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000005', 'UTC+3')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('18:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A6. wrong-case zone (non-vacuous) — lowercase america/new_york falls back to Prague, NOT resolved case-insensitively',
      // Catches: someone "fixing" the join's `=` to `ILIKE`. Verified against
      // Postgres 17: fallback gives 00:00:00, an ILIKE-normalised join would
      // give 18:00:00 — the two answers differ by 18h, so this is
      // non-vacuous either way the assertion could go wrong.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000006', 'america/new_york')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '23:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              // Europe/Prague fallback (00:00:00), NOT the case-insensitively
              // resolved America/New_York answer (18:00:00).
              expect(row.start_time).toBe('00:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A7. NEGATIVE OFFSET (timezone-test mandate) — America/New_York, 23:00 becomes 18:00',
      // Catches: a whole-zone hard-coding, or the offset arithmetic applied
      // with the wrong sign (an east-of-UTC assumption baked in).
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000007', 'America/New_York')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '23:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('18:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A8. NON-WHOLE-HOUR OFFSET (timezone-test mandate) — Asia/Kathmandu (+5:45), 12:30 becomes 18:15',
      // Catches: any hour-granularity arithmetic (e.g. `start_time + offset
      // AS a whole-hour interval`) instead of a real `AT TIME ZONE`.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000008', 'Asia/Kathmandu')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '12:30:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('18:15:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A9. anchor is start_date, not CURRENT_DATE/today — Prague and Lord Howe each get a winter/summer pair',
      // Catches: `CURRENT_DATE`/`now()` anchoring instead of `es.start_date`
      // — both rows of a pair would land on the SAME converted value
      // whichever half of the year CI happens to run in, which this
      // deliberately cross-seasonal pair rules out. Lord Howe additionally
      // pins the 30-minute DST step (its summer/winter offsets differ by
      // 0:30, not a whole hour), so a bug that only breaks on a 1-hour DST
      // step would still pass without it.
      () =>
        Effect.Do.pipe(
          Effect.bind('prague', () => setupTeam('970100000000000009', 'Europe/Prague')),
          Effect.bind('lordHowe', () => setupTeam('970100000000000010', 'Australia/Lord_Howe')),
          Effect.bind('pragueJan', ({ prague }) =>
            insertRawSeries({
              teamId: prague.teamId,
              createdBy: prague.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('pragueJul', ({ prague }) =>
            insertRawSeries({
              teamId: prague.teamId,
              createdBy: prague.memberId,
              startDate: '2026-07-07',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('lordHoweJan', ({ lordHowe }) =>
            insertRawSeries({
              teamId: lordHowe.teamId,
              createdBy: lordHowe.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('lordHoweJul', ({ lordHowe }) =>
            insertRawSeries({
              teamId: lordHowe.teamId,
              createdBy: lordHowe.memberId,
              startDate: '2026-07-07',
              startTime: '17:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('pragueJanRow', ({ pragueJan }) => readSeriesRow(pragueJan)),
          Effect.bind('pragueJulRow', ({ pragueJul }) => readSeriesRow(pragueJul)),
          Effect.bind('lordHoweJanRow', ({ lordHoweJan }) => readSeriesRow(lordHoweJan)),
          Effect.bind('lordHoweJulRow', ({ lordHoweJul }) => readSeriesRow(lordHoweJul)),
          Effect.tap(({ pragueJanRow, pragueJulRow, lordHoweJanRow, lordHoweJulRow }) =>
            Effect.sync(() => {
              expect(pragueJanRow.start_time).toBe('18:00:00');
              expect(pragueJulRow.start_time).toBe('19:00:00');
              // Lord Howe: DST (summer, +11) is January there; standard
              // (+10:30) is July — the reverse hemisphere of Prague.
              expect(lordHoweJanRow.start_time).toBe('04:00:00');
              expect(lordHoweJulRow.start_time).toBe('03:30:00');
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A10. end_time IS NULL — stays NULL; WEAKLY DISCRIMINATING, labelled honestly',
      // Catches: a `COALESCE(end_time, <literal>)` that materialises a fake
      // end time, or a NOT NULL violation on write. Does NOT meaningfully
      // test the `CASE` in Statement A — NULL propagates through
      // `start_date + NULL` on its own, so an implementation without the
      // `CASE` at all would also pass this. What it DOES still confirm:
      // start_time converts and the flag flips even when end_time is NULL.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000011', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              endTime: null,
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('18:00:00');
              expect(row.end_time).toBeNull();
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A11. a row ALREADY times_are_team_local = TRUE is left completely untouched by Statement A',
      // Catches: a guard weakened to "convert everything" regardless of the
      // flag. Distinct from A2 (idempotence): this row was NEVER converted by
      // this migration at all — if Statement A ignored the guard it would
      // reinterpret an already-correct wall clock as UTC and corrupt it.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000012', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              timesAreTeamLocal: true,
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('17:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A12. crossing midnight — start_time and end_time convert independently, ordering preserved',
      // Catches: an implementation deriving end_time as `start_time +
      // duration` instead of converting it independently, or anchoring
      // end_time on a different date than start_time.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000013', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '22:00:00',
              endTime: '01:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('23:00:00');
              expect(row.end_time).toBe('02:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A13. southern hemisphere day roll — Australia/Sydney, January, 17:00 becomes 04:00 (date rolls, only time is stored)',
      // Catches: a `::timestamp` cast that leaks the rolled date into the
      // stored value (there is no date column on event_series to hold it), or
      // a guard that rejects/mishandles the roll.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000014', 'Australia/Sydney')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('04:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'A14. a CANCELLED series still converts — no status filter on Statement A',
      // Catches: someone adding `AND es.status = 'active'` to Statement A,
      // which would leave a cancelled-but-FALSE series permanently
      // mislabelled if it were ever reactivated.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970100000000000015', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              status: 'cancelled',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.start_time).toBe('18:00:00');
              expect(row.times_are_team_local).toBe(true);
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );
  });

  // =========================================================================
  // Statement B
  // =========================================================================
  // Shared fixture shape unless noted: Prague team, series start_date
  // 2026-01-06, start_time 17:00/end_time 19:00 (-> 18:00/20:00 after A),
  // event start_at 2027-07-07T17:00:00Z — a summer occurrence materialized
  // straight from the winter-stored UTC value, the exact stranded shape the
  // pre-#650 bug produces. Dated 2027 throughout: B's guard is
  // `start_at >= now()`, and three of the plan's original fixtures were
  // dated in the past and silently never ran (Blocker 2).
  describe('Statement B — re-anchors already-materialized future/active/unmodified occurrences', () => {
    it.effect(
      'B1. future / active / unmodified event round-trips through the corrected wall clock',
      // Catches: Statement B deleted entirely, or the wrong zone on either
      // side of the round trip. Verified against Postgres 17.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000001', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              endTime: '19:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T17:00:00Z',
              endAtIso: '2027-07-07T19:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T16:00:00.000Z');
              expect(row.endAtIso).toBe('2027-07-07T18:00:00.000Z');
              expect(row.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B2. series_modified = true is left completely untouched',
      // Catches: a missing `NOT e.series_modified` guard, which would clobber
      // a captain's per-occurrence override.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000002', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T17:00:00Z',
              seriesModified: true,
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T17:00:00.000Z');
              expect(row.personalMessagesDirtyAt).toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      "B3. status = 'cancelled' is left completely untouched",
      // Catches: a missing `status = 'active'` guard.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000003', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T17:00:00Z',
              status: 'cancelled',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T17:00:00.000Z');
              expect(row.personalMessagesDirtyAt).toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      "B4. status = 'started' is left completely untouched",
      // Catches: a guard written as `status <> 'cancelled'` instead of the
      // correct `= 'active'` (which would incorrectly also match 'started').
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000004', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T17:00:00Z',
              status: 'started',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T17:00:00.000Z');
              expect(row.personalMessagesDirtyAt).toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B5. a PAST occurrence is left completely untouched',
      // Catches: a missing `start_at >= now()` guard, which would rewrite
      // history and falsify attendance records.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000005', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2020-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              // Safely in the past relative to whenever this test actually runs.
              startAtIso: '2020-07-07T17:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2020-07-07T17:00:00.000Z');
              expect(row.personalMessagesDirtyAt).toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B6. a standalone event (series_id IS NULL) is left completely untouched',
      // Catches: a `WHERE` that lost the `e.series_id = es.id` join and
      // matched every future active event regardless of series membership.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000006', 'Europe/Prague')),
          Effect.bind('eventId', ({ setup }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId: null,
              startAtIso: '2027-07-07T17:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T17:00:00.000Z');
              expect(row.personalMessagesDirtyAt).toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B7. an event of an ALREADY times_are_team_local = TRUE series is left completely untouched',
      // THE WITHDRAWN STATEMENT B (unrestricted, all series) FAILS THIS CASE.
      // Catches: Statement B missing the `es.id = ANY(convertedIds)`
      // restriction to just the series Statement A converted THIS run — an
      // unrestricted B would also rewrite this row, and (per the plan's
      // §B.1 defect 2) can only ever make an already-correct row worse,
      // because Postgres's fall-back-hour disambiguation disagrees with the
      // JS resolver's.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000007', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              // Already the CONVERTED value — this series was never FALSE.
              startTime: '18:00:00',
              timesAreTeamLocal: true,
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              // Already correctly anchored via the team-local wall clock.
              startAtIso: '2027-07-07T16:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T16:00:00.000Z');
              expect(row.personalMessagesDirtyAt).toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B8. near-midnight series, NO day jump — the single most valuable case in this file',
      // Verified against Postgres 17. THE WITHDRAWN (team-local-date)
      // STATEMENT B gives `2027-07-07T21:00:00.000Z` here — a 23-HOUR SHIFT
      // — because it recovers the occurrence date in the TEAM zone rather
      // than UTC (see the plan's §B.1 defect 1: 22:00Z is already
      // 00:00-next-day at Prague's +2 summer offset, so the team-local date
      // of the old value is 07-07, one day ahead of its UTC date 07-06).
      // The RECOMMENDED form (UTC-date recovery) gives 2027-07-06T21:00:00Z,
      // asserted below. Dated 2027 deliberately (Blocker 2): the plan's
      // original 2026-dated fixture for this exact case was already in the
      // past by the time `start_at >= now()` ran, so it never executed at
      // all — this is the case the review called out as the worst instance
      // of that defect.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000008', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2027-01-05',
              startTime: '22:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-06T22:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          // Statement A's own output, sanity-checked inline: 23:00:00, not
          // the withdrawn form's confusion source.
          Effect.bind('seriesRow', ({ seriesId }) => readSeriesRow(seriesId)),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ seriesRow, row }) =>
            Effect.sync(() => {
              expect(seriesRow.start_time).toBe('23:00:00');
              expect(row.startAtIso).toBe('2027-07-06T21:00:00.000Z');
              expect(row.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B9. end_at handling — NULL end_time clears a stale end_at; non-NULL end_time fills a missing one',
      // Catches: either half silently dropped, or an end_at anchored on its
      // own (wrong) date instead of start_at's occurrence date. Both
      // behaviours are intentional and mirror
      // `EventsRepository.updateFutureUnmodified`.
      () =>
        Effect.Do.pipe(
          Effect.bind('teamA', () => setupTeam('970200000000000009', 'Europe/Prague')),
          Effect.bind('teamB', () => setupTeam('970200000000000010', 'Europe/Prague')),
          // (a) es.end_time IS NULL, event's stored end_at is non-null (stale).
          Effect.bind('seriesA', ({ teamA }) =>
            insertRawSeries({
              teamId: teamA.teamId,
              createdBy: teamA.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              endTime: null,
            }),
          ),
          Effect.bind('eventA', ({ teamA, seriesA }) =>
            insertRawSeriesEvent({
              teamId: teamA.teamId,
              createdBy: teamA.memberId,
              seriesId: seriesA,
              startAtIso: '2027-07-07T17:00:00Z',
              endAtIso: '2027-07-07T19:00:00Z',
            }),
          ),
          // (b) es.end_time is non-null, event's stored end_at is NULL (missing).
          Effect.bind('seriesB', ({ teamB }) =>
            insertRawSeries({
              teamId: teamB.teamId,
              createdBy: teamB.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              endTime: '19:00:00',
            }),
          ),
          Effect.bind('eventB', ({ teamB, seriesB }) =>
            insertRawSeriesEvent({
              teamId: teamB.teamId,
              createdBy: teamB.memberId,
              seriesId: seriesB,
              startAtIso: '2027-07-07T17:00:00Z',
              endAtIso: null,
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('rowA', ({ eventA }) => readEventRow(eventA)),
          Effect.bind('rowB', ({ eventB }) => readEventRow(eventB)),
          Effect.tap(({ rowA, rowB }) =>
            Effect.sync(() => {
              expect(rowA.startAtIso).toBe('2027-07-07T16:00:00.000Z');
              expect(rowA.endAtIso).toBeNull();
              expect(rowB.startAtIso).toBe('2027-07-07T16:00:00.000Z');
              expect(rowB.endAtIso).toBe('2027-07-07T18:00:00.000Z');
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B10. re-run is a PROVABLE no-op — start_at and personal_messages_dirty_at are byte-identical',
      // Catches: an unrestricted Statement B that re-stamps `dirty_at` on
      // every run regardless of whether A converted anything this run (the
      // withdrawn, unrestricted form fails this), and a double-shifted
      // `start_at`. On a genuine re-run, Statement A converts nothing, so
      // `convertedIds` is empty and `= ANY('{}')` matches nothing — B is a
      // provable no-op, INCLUDING the dirty-at stamp, which is the sharpest
      // observable difference from the withdrawn design.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000011', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T17:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('afterFirstRun', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(() => runMigration()),
          Effect.bind('afterSecondRun', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ afterFirstRun, afterSecondRun }) =>
            Effect.sync(() => {
              expect(afterSecondRun.startAtIso).toBe(afterFirstRun.startAtIso);
              expect(afterSecondRun.personalMessagesDirtyAt?.getTime()).toBe(
                afterFirstRun.personalMessagesDirtyAt?.getTime(),
              );
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B11. fall-back (DST-ambiguous) hour — moves to the LATER instant, disagreeing with the JS resolver by design',
      // Pins the documented Postgres/JS disagreement (applications/server/AGENTS.md
      // "JS and Postgres Disagree On DST-Ambiguous Wall Clocks") so a future
      // `AT TIME ZONE` behaviour change surfaces here rather than silently.
      // `resolveOccurrenceInstant`'s "compatible" disambiguation would give
      // 2027-10-31T00:30:00.000Z (the EARLIER instant) for the same wall
      // clock; Postgres gives 01:30Z (the LATER one), asserted below.
      // Anchored on `start_date 2027-07-07` — the OTHER side of the DST
      // boundary from the event itself — DELIBERATELY: with `start_date` in
      // the same offset as the occurrence, the row comes back byte-identical
      // to its own seed and the case passes even with Statement B deleted.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000012', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2027-07-07',
              startTime: '00:30:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-10-31T00:30:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              // It MOVES — not byte-identical to the seed.
              expect(row.startAtIso).toBe('2027-10-31T01:30:00.000Z');
              expect(row.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B12. spring-forward gap — Postgres and the JS resolver AGREE, pinned so a future divergence is caught',
      // Same anchoring trick as B11 (start_date on the far side of the DST
      // boundary from the event) so the row is forced to move — the
      // original fixture for this case was both past-dated AND had the
      // seeded value equal the asserted value, so it passed green while
      // testing nothing.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000013', 'Europe/Prague')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2027-07-07',
              startTime: '00:30:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-03-28T00:30:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-03-28T01:30:00.000Z');
              expect(row.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B13. NEGATIVE OFFSET (timezone-test mandate) — America/New_York',
      // Catches: a zone hard-coded to an eastern (positive) offset somewhere
      // in Statement B's date-recovery arithmetic.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000014', 'America/New_York')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '23:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T23:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T22:00:00.000Z');
              expect(row.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B14. NON-WHOLE-HOUR OFFSET (timezone-test mandate) — Asia/Kathmandu; NO-OP BY CONSTRUCTION, so the dirty stamp is what proves the row was matched',
      // A fixed +5:45 offset can never move a wall clock under B — there is
      // no DST in Kathmandu, so the instant assertion ALONE would pass even
      // if the row were never matched by the UPDATE at all (it would just
      // stay at its seeded value). The dirty-at assertion is what actually
      // proves Statement B touched this row; the instant assertion still
      // confirms the `:45` offset round-trips exactly rather than being
      // truncated to a whole hour somewhere in the date-recovery arithmetic.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000015', 'Asia/Kathmandu')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '12:30:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T12:30:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              expect(row.startAtIso).toBe('2027-07-07T12:30:00.000Z');
              expect(row.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B15. UNIQUE-INDEX COLLISION (Blocker 1) — one series, four occurrences on adjacent UTC dates, converted clock rolls the date',
      // `idx_events_series_date` is a non-deferrable unique index on
      // `(series_id, (start_at AT TIME ZONE 'UTC')::date)`
      // (`1741800000_event_datetime_columns.ts:24`). Statement B rewrites
      // `start_at` for every matched row of this series, so it can collide
      // with its own still-live rows mid-statement. The migration brackets
      // Statement B with `DROP INDEX` / `CREATE UNIQUE INDEX` for this
      // reason. No other case in this file has a series with more than one
      // occurrence, which is why the defect survived six prior reviews.
      //
      // THE FIXTURE MUST SHIFT THE UTC DATE FORWARD, or it does not
      // discriminate. What decides the collision is the shift DIRECTION, not
      // physical row order: `EXPLAIN (ANALYZE, VERBOSE)` shows Statement B
      // planned as a nested loop driven by an Index Scan on
      // `idx_events_series_date` itself, so rows are visited in ascending
      // `(series_id, date)` order whatever order they were inserted in. Under
      // ascending order a BACKWARD shift is always safe — each row vacates
      // its slot before the row above claims it — while a FORWARD shift walks
      // each row into its successor's still-live slot.
      //
      // So the earlier `Europe/Prague`, `23:15` form of this fixture (a
      // positive-offset zone, which can only shift backward) passed with the
      // bracket REMOVED and guarded nothing. The "descending insertion order
      // reliably fails" claim in the plan and in this comment's first
      // revision is WRONG for the same reason.
      //
      // VERIFIED BOTH WAYS (2026-09-22, against the real testcontainer, after
      // a full `pnpm build` — see the note on stale `dist` in this file's
      // header):
      //
      //   bracket present  -> passes
      //   bracket removed  -> ERROR 23505, duplicate key on
      //                       idx_events_series_date, Key (series_id,
      //                       ((start_at AT TIME ZONE 'UTC')::date))
      //                       = (..., 2027-07-11)
      //
      // The four occurrences are seeded on four DISTINCT UTC dates
      // (2027-07-10..13 at 12:00Z), so no seed-time collision is possible and
      // the reported key is necessarily a POST-conversion date.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000016', 'America/New_York')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2027-01-05',
              startTime: '02:15:00',
            }),
          ),
          Effect.bind('event13', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-13T12:00:00Z',
            }),
          ),
          Effect.bind('event12', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-12T12:00:00Z',
            }),
          ),
          Effect.bind('event11', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-11T12:00:00Z',
            }),
          ),
          Effect.bind('event10', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-10T12:00:00Z',
            }),
          ),
          // Must not throw `duplicate key value violates unique constraint
          // "idx_events_series_date"`.
          Effect.tap(() => runMigration()),
          Effect.bind('row10', ({ event10 }) => readEventRow(event10)),
          Effect.bind('row11', ({ event11 }) => readEventRow(event11)),
          Effect.bind('row12', ({ event12 }) => readEventRow(event12)),
          Effect.bind('row13', ({ event13 }) => readEventRow(event13)),
          Effect.tap(({ row10, row11, row12, row13 }) =>
            Effect.sync(() => {
              expect(row10.startAtIso).toBe('2027-07-11T01:15:00.000Z');
              expect(row11.startAtIso).toBe('2027-07-12T01:15:00.000Z');
              expect(row12.startAtIso).toBe('2027-07-13T01:15:00.000Z');
              expect(row13.startAtIso).toBe('2027-07-14T01:15:00.000Z');
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );

    it.effect(
      'B16. no team_settings row — Statement B falls back to Europe/Prague, not skipped by an inner join',
      // Renumbered from the plan's own duplicate "B15" (§F reuses that id for
      // two different cases; flagged to the architect). Catches: an inner
      // join in STATEMENT B specifically — A3 only proves the fallback on
      // Statement A's side, and B has its own independent `<TZ>` subselect.
      () =>
        Effect.Do.pipe(
          Effect.bind('setup', () => setupTeam('970200000000000017')),
          Effect.bind('seriesId', ({ setup }) =>
            insertRawSeries({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              endTime: '19:00:00',
            }),
          ),
          Effect.bind('eventId', ({ setup, seriesId }) =>
            insertRawSeriesEvent({
              teamId: setup.teamId,
              createdBy: setup.memberId,
              seriesId,
              startAtIso: '2027-07-07T17:00:00Z',
              endAtIso: '2027-07-07T19:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
          Effect.tap(({ row }) =>
            Effect.sync(() => {
              // Same result as B1's Europe/Prague fixture.
              expect(row.startAtIso).toBe('2027-07-07T16:00:00.000Z');
              expect(row.endAtIso).toBe('2027-07-07T18:00:00.000Z');
              expect(row.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );
  });

  // =========================================================================
  // Cross-cutting
  // =========================================================================
  describe('Cross-cutting', () => {
    it.effect(
      'X2. full-run fidelity — many series across several teams converted correctly in ONE migration run',
      // Catches: per-row UPDATE logic that only happens to work when the
      // table has a single matching row (e.g. a mis-correlated subselect
      // that leaks a value from one row into another, or a `LIMIT 1`
      // accidentally left on a subquery). Deliberately spans MULTIPLE teams
      // (not "one team" as the plan's own table literally says) because
      // A7/A8's whole point is a specific non-Prague zone, and a team has
      // exactly one timezone — see the tester report for this deviation.
      // Setup and read-back are each batched through a single `Effect.all`
      // bind — `Effect.Do.pipe` has a hard cap of 20 chained operations
      // (TS2554 `Expected 0-20 arguments`) and this scenario's original
      // one-bind-per-value shape exceeded it at 22.
      () =>
        Effect.Do.pipe(
          Effect.bind('teams', () =>
            Effect.all({
              prague: setupTeam('970300000000000001', 'Europe/Prague'),
              newYork: setupTeam('970300000000000002', 'America/New_York'),
              kathmandu: setupTeam('970300000000000003', 'Asia/Kathmandu'),
            }),
          ),
          // A1-style
          Effect.bind('seriesA1', ({ teams }) =>
            insertRawSeries({
              teamId: teams.prague.teamId,
              createdBy: teams.prague.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
            }),
          ),
          // A7-style (negative offset)
          Effect.bind('seriesA7', ({ teams }) =>
            insertRawSeries({
              teamId: teams.newYork.teamId,
              createdBy: teams.newYork.memberId,
              startDate: '2026-01-06',
              startTime: '23:00:00',
            }),
          ),
          // A8-style (non-whole-hour offset)
          Effect.bind('seriesA8', ({ teams }) =>
            insertRawSeries({
              teamId: teams.kathmandu.teamId,
              createdBy: teams.kathmandu.memberId,
              startDate: '2026-01-06',
              startTime: '12:30:00',
            }),
          ),
          // A9-style pair (anchor is start_date)
          Effect.bind('seriesA9Jan', ({ teams }) =>
            insertRawSeries({
              teamId: teams.prague.teamId,
              createdBy: teams.prague.memberId,
              startDate: '2026-01-06',
              startTime: '20:00:00',
            }),
          ),
          Effect.bind('seriesA9Jul', ({ teams }) =>
            insertRawSeries({
              teamId: teams.prague.teamId,
              createdBy: teams.prague.memberId,
              startDate: '2026-07-07',
              startTime: '20:00:00',
            }),
          ),
          // A12-style (crossing midnight)
          Effect.bind('seriesA12', ({ teams }) =>
            insertRawSeries({
              teamId: teams.prague.teamId,
              createdBy: teams.prague.memberId,
              startDate: '2026-01-06',
              startTime: '22:00:00',
              endTime: '01:00:00',
            }),
          ),
          // A14-style (cancelled)
          Effect.bind('seriesA14', ({ teams }) =>
            insertRawSeries({
              teamId: teams.prague.teamId,
              createdBy: teams.prague.memberId,
              startDate: '2026-01-06',
              startTime: '17:00:00',
              status: 'cancelled',
            }),
          ),
          // One event, tied to the A1-style series, so Statement B's
          // per-row correctness is exercised alongside Statement A's in the
          // same multi-row run.
          Effect.bind('eventA1', ({ teams, seriesA1 }) =>
            insertRawSeriesEvent({
              teamId: teams.prague.teamId,
              createdBy: teams.prague.memberId,
              seriesId: seriesA1,
              startAtIso: '2027-07-07T17:00:00Z',
            }),
          ),
          Effect.tap(() => runMigration()),
          Effect.bind(
            'rows',
            ({
              seriesA1,
              seriesA7,
              seriesA8,
              seriesA9Jan,
              seriesA9Jul,
              seriesA12,
              seriesA14,
              eventA1,
            }) =>
              Effect.all({
                rowA1: readSeriesRow(seriesA1),
                rowA7: readSeriesRow(seriesA7),
                rowA8: readSeriesRow(seriesA8),
                rowA9Jan: readSeriesRow(seriesA9Jan),
                rowA9Jul: readSeriesRow(seriesA9Jul),
                rowA12: readSeriesRow(seriesA12),
                rowA14: readSeriesRow(seriesA14),
                eventRowA1: readEventRow(eventA1),
              }),
          ),
          Effect.tap(({ rows }) =>
            Effect.sync(() => {
              expect(rows.rowA1.start_time).toBe('18:00:00');
              expect(rows.rowA1.times_are_team_local).toBe(true);
              expect(rows.rowA7.start_time).toBe('18:00:00');
              expect(rows.rowA7.times_are_team_local).toBe(true);
              expect(rows.rowA8.start_time).toBe('18:15:00');
              expect(rows.rowA8.times_are_team_local).toBe(true);
              expect(rows.rowA9Jan.start_time).toBe('21:00:00');
              expect(rows.rowA9Jul.start_time).toBe('22:00:00');
              expect(rows.rowA12.start_time).toBe('23:00:00');
              expect(rows.rowA12.end_time).toBe('02:00:00');
              expect(rows.rowA14.start_time).toBe('18:00:00');
              expect(rows.rowA14.times_are_team_local).toBe(true);
              expect(rows.eventRowA1.startAtIso).toBe('2027-07-07T16:00:00.000Z');
              expect(rows.eventRowA1.personalMessagesDirtyAt).not.toBeNull();
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );
  });
});
