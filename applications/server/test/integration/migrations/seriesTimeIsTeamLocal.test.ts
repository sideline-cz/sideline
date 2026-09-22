// TDD mode — `.work-plans/series-time-conversion.md` §F is the test specification for
// `1792100000_series_time_is_team_local.ts` (Statements A and B only; Statement C is dropped —
// see the plan's header and §A "Statement C ... DROPPED, do not implement"). Every literal
// asserted below is quoted from §F/§A/§B.1/§C, all independently executed against a real
// postgres:17 per the plan's own header — none are hand-computed here.
//
// Harness copied from `addSeriesTimesTeamLocalFlag.test.ts` / the withdrawn
// `1791600000_series_time_is_team_local.ts` test (recovered from commit `0897f9a1`): deep
// default-import of the migration module, `TestPgClient`, `beforeEach(cleanDatabase)`,
// `it.effect`, `Effect.Do.pipe` (never `Effect.gen`), raw `INSERT` for pre-migration row shapes
// that no repository can produce.
//
// `1792100000_series_time_is_team_local.ts` is being written concurrently and may not exist (or
// may not yet be built into `packages/migrations/dist`) when this file is first run — every case
// below is then expected to fail at module-resolution time, not on its own assertion. That is the
// correct first shape of "red" for this file.
//
// `runMigration()` executes the migration's OWN Effect directly against this harness's database
// connection — it is NOT wrapped in a transaction here (unlike the real migrator, which runs the
// whole pending set inside one `sql.withTransaction`). A failure partway through a single case
// (e.g. between the `DROP INDEX` and the `CREATE UNIQUE INDEX`) therefore leaves
// `idx_events_series_date` missing/absent from the schema for the REST of this serial test run,
// not just the failing case — a later case's `pg_indexes` assertion or unique-collision case can
// then fail for a reason that has nothing to do with its own fixture. If a run produces a cluster
// of unrelated-looking failures downstream of one case, check that case's migration run for a
// mid-statement error first, in one step, rather than re-running three times to find it.
//
// Case selection vs. §F: C1–C3 are skipped (Statement C dropped) and X1 is skipped (the plan
// itself calls it vacuous — it tests `sql.withTransaction`/Postgres DDL transactionality, not
// this migration). A1–A14, B1–B15 (both of them — §F lists "B15" twice, for two different cases)
// and X2 are implemented.

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
// Seed helpers (mirrors the withdrawn 1791600000 test / anchorAllDayToTeamMidnight.test.ts)
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
        name: 'Series Time Is Team Local Test Team',
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
 * Creates a user + team + team member, and OPTIONALLY a `team_settings` row (with an arbitrary,
 * possibly INVALID, timezone string — this repository call performs no validation). Passing
 * `timezone: undefined` leaves the team WITHOUT a `team_settings` row at all — required by A3/B15
 * ("no team_settings row").
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
 * Seeds a team whose `team_settings.timezone` holds a value the LIVE `team_settings_timezone_check`
 * CHECK constraint (`1792000005_team_settings_timezone_check.ts`, already applied by the time this
 * test file's migration bootstrap runs, since `1792000005 < 1792100000`) would itself reject with
 * SQLSTATE 22023 on an ordinary `INSERT`/`UPDATE` — required for A4 (`'Mars/Olympus'`) and A5
 * (`''`), which model a row that predates that CHECK (an operator/migration/legacy write from
 * before it existed). The CHECK is dropped immediately before the raw `INSERT` and re-added
 * `NOT VALID` immediately after (so it is NOT re-validated against the row just inserted, but IS
 * still enforced for every subsequent write in the rest of this test run) — this simulates the
 * pre-CHECK legacy shape without weakening the constraint for any other test.
 */
const setupTeamWithLegacyInvalidTimezone = (guildId: string, timezone: string) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(guildId)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    // The `DROP CONSTRAINT` / raw `INSERT` / `ADD CONSTRAINT ... NOT VALID` re-add is wrapped in
    // `Effect.ensuring` so the re-add always runs, even if the `INSERT` itself fails (e.g. a
    // future `NOT NULL` column on `team_settings` with no default). Without this, a failing
    // `INSERT` would leave `team_settings_timezone_check` dropped for the REST of this serial
    // integration run, and any later test asserting a 22023 rejection from that CHECK would pass
    // spuriously. This does not change behaviour on the passing path: `NOT VALID` still enforces
    // the CHECK on every subsequent write and only skips back-validating this one pre-existing row.
    Effect.tap(({ team }) =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap((sql) =>
          sql`ALTER TABLE team_settings DROP CONSTRAINT IF EXISTS team_settings_timezone_check`.pipe(
            Effect.andThen(() =>
              sql.unsafe(
                `INSERT INTO team_settings (team_id, timezone) VALUES ('${team.id}', '${timezone}')`,
              ),
            ),
            // `Effect.orDie`: a finalizer may not fail, and there is no sensible recovery if the
            // re-add itself errors — that means the CHECK is now gone for the rest of the run, so
            // failing loudly as a defect is exactly right.
            Effect.ensuring(
              Effect.orDie(sql`
                ALTER TABLE team_settings
                  ADD CONSTRAINT team_settings_timezone_check
                  CHECK (now() AT TIME ZONE timezone IS NOT NULL) NOT VALID
              `),
            ),
          ),
        ),
      ),
    ),
    Effect.map(({ team, member }) => ({
      teamId: team.id as string,
      memberId: (member as unknown as { id: string }).id,
    })),
  );

/**
 * Raw INSERT of an `event_series` row, bypassing `EventSeriesRepository` entirely — this
 * migration's whole job is converting rows that predate its own conversion, which nothing written
 * through the repository can produce.
 *
 * `timesAreTeamLocal` (new vs. the withdrawn harness, per §F "Two harness additions"): omitted by
 * default (matching the pre-migration/pre-write-path shape), so the column falls to whatever
 * `1791700000` set it to (`FALSE`). Pass `true` to seed a genuinely pre-existing `TRUE` row for
 * A11/B7.
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
                                   days_of_week, start_date, end_date, created_by, status
                                   ${params.timesAreTeamLocal === undefined ? '' : ', times_are_team_local'})
        VALUES (
          '${params.teamId}', 'Weekly Training', '${params.startTime}'::time,
          ${params.endTime == null ? 'NULL' : `'${params.endTime}'::time`},
          'weekly', ARRAY[2], '${params.startDate}'::date, NULL, '${params.createdBy}',
          '${params.status ?? 'active'}'
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
  seriesId: string;
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
          '${params.createdBy}', '${params.seriesId}', ${params.seriesModified ?? false},
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

/** Raw INSERT of a STANDALONE event (no series) — for B6. */
const insertRawStandaloneEvent = (params: {
  teamId: string;
  createdBy: string;
  startAtIso: string;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ id: string }>(`
        INSERT INTO events (team_id, event_type, title, start_at, created_by, status)
        VALUES (
          '${params.teamId}', 'training', 'Standalone Training',
          '${params.startAtIso}'::timestamptz, '${params.createdBy}', 'active'
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

/**
 * Reads back `idx_events_series_date`'s definition from `pg_indexes`. Nothing else in this file
 * touches `pg_index`/`pg_indexes` — without this, deleting the migration's trailing
 * `CREATE UNIQUE INDEX` (and thus permanently losing production's only duplicate-occurrence
 * backstop, since `EventHorizonCron` writes with no `ON CONFLICT`) leaves every case in this file
 * green.
 */
const readEventsSeriesDateIndexDef = () =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_events_series_date'`,
      ),
    ),
    Effect.map((rows) => rows[0]?.indexdef ?? null),
  );

/**
 * Byte-equivalent (modulo Postgres's own normalisation/whitespace) to the original definition in
 * `packages/migrations/src/before/1741800000_event_datetime_columns.ts`:
 * `CREATE UNIQUE INDEX idx_events_series_date ON events(series_id, ((start_at AT TIME ZONE
 * 'UTC')::date)) WHERE series_id IS NOT NULL`. Captured by executing that exact `CREATE UNIQUE
 * INDEX` against a real postgres:17 and reading back `pg_indexes.indexdef` — Postgres always
 * schema-qualifies (`public.events`), spells out `USING btree`, and adds an explicit `::text`
 * cast on the timezone literal that the source SQL leaves implicit.
 */
const EXPECTED_EVENTS_SERIES_DATE_INDEXDEF =
  "CREATE UNIQUE INDEX idx_events_series_date ON public.events USING btree (series_id, (((start_at AT TIME ZONE 'UTC'::text))::date)) WHERE (series_id IS NOT NULL)";

/** Runs the migration's own Effect against the test database. Safe to reference more than once
 * in the same chain — each reference is a fresh execution, exactly like an operator re-running
 * the migration by hand. */
const runMigration = () => seriesTimeIsTeamLocal;

describe('migration 1792100000 — converts series times to team-local wall clock (Statements A + B)', () => {
  // -------------------------------------------------------------------------
  // Statement A
  // -------------------------------------------------------------------------

  it.effect("A1. happy path — Prague winter, '17:00' -> '18:00:00'", () =>
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
          // Catches: Statement A deleted, or the `AT TIME ZONE` operands swapped (would give 16:00).
          expect(row.start_time).toBe('18:00:00');
          expect(row.times_are_team_local).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    "A2. IDEMPOTENCE — running the migration TWICE still leaves '18:00:00', not '19:00:00'. " +
      'The single most important case in the file: catches a missing `WHERE NOT ' +
      'es.times_are_team_local`, or the flag being set in a separate statement from the write.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970100000000000002', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('afterFirstRun', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.tap(({ afterFirstRun }) =>
          Effect.sync(() => {
            expect(afterFirstRun.start_time).toBe('18:00:00');
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('afterSecondRun', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.tap(({ afterSecondRun }) =>
          Effect.sync(() => {
            expect(afterSecondRun.start_time).toBe('18:00:00');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'A3. no team_settings row -> falls back to Europe/Prague (18:00:00, true). Catches ' +
      '`UPDATE ... FROM team_settings` (an inner join) — the row would stay 17:00/false.',
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
    "A4. unrecognised zone ('Mars/Olympus') does NOT throw, falls back to 18:00:00. Catches a " +
      'missing `pg_timezone_names` join (raises 22023, aborts the migration, fails server boot).',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () =>
          setupTeamWithLegacyInvalidTimezone('970100000000000004', 'Mars/Olympus'),
        ),
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
    "A5. empty-string zone ('') does NOT throw, falls back to 18:00:00. Same defence as A4, a " +
      "distinct parse failure (`AT TIME ZONE ''`).",
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeamWithLegacyInvalidTimezone('970100000000000005', '')),
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
    "A6. wrong-case zone ('america/new_york') with start_time '23:00:00' falls back to " +
      "Europe/Prague (00:00:00), NOT the ILIKE answer (18:00:00). Catches someone 'fixing' the " +
      'case-sensitive `=` to `ILIKE` — the two answers differ by 18h, verified.',
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
            expect(row.start_time).toBe('00:00:00');
            expect(row.times_are_team_local).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'A7. negative-offset zone mandate — America/New_York, 23:00 -> 18:00:00. Catches whole-zone ' +
      'hard-coding / the west-of-UTC anchor-overflow bug class.',
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
    'A8. non-whole-hour zone mandate — Asia/Kathmandu (+5:45), 12:30 -> 18:15:00. Catches any ' +
      'hour-granularity arithmetic.',
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
    'A9. anchor is start_date, NOT today — two Prague series, same start_time 17:00, ' +
      'start_date 2026-01-06 vs 2026-07-07 -> 18:00:00 and 19:00:00; paired with ' +
      'Australia/Lord_Howe (04:00:00 Jan vs 03:30:00 Jul, the 30-minute DST step). Catches ' +
      '`CURRENT_DATE`/`now()` anchoring — both rows would get the same value whichever half of ' +
      'the year CI runs in.',
    () =>
      Effect.Do.pipe(
        Effect.bind('prague', () => setupTeam('970100000000000009', 'Europe/Prague')),
        Effect.bind('lordHowe', () => setupTeam('970100000000000010', 'Australia/Lord_Howe')),
        Effect.bind('pragueWinter', ({ prague }) =>
          insertRawSeries({
            teamId: prague.teamId,
            createdBy: prague.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
          }),
        ),
        Effect.bind('pragueSummer', ({ prague }) =>
          insertRawSeries({
            teamId: prague.teamId,
            createdBy: prague.memberId,
            startDate: '2026-07-07',
            startTime: '17:00:00',
          }),
        ),
        Effect.bind('lordHoweWinter', ({ lordHowe }) =>
          insertRawSeries({
            teamId: lordHowe.teamId,
            createdBy: lordHowe.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
          }),
        ),
        Effect.bind('lordHoweSummer', ({ lordHowe }) =>
          insertRawSeries({
            teamId: lordHowe.teamId,
            createdBy: lordHowe.memberId,
            startDate: '2026-07-07',
            startTime: '17:00:00',
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('pragueWinterRow', ({ pragueWinter }) => readSeriesRow(pragueWinter)),
        Effect.bind('pragueSummerRow', ({ pragueSummer }) => readSeriesRow(pragueSummer)),
        Effect.bind('lordHoweWinterRow', ({ lordHoweWinter }) => readSeriesRow(lordHoweWinter)),
        Effect.bind('lordHoweSummerRow', ({ lordHoweSummer }) => readSeriesRow(lordHoweSummer)),
        Effect.tap(({ pragueWinterRow, pragueSummerRow, lordHoweWinterRow, lordHoweSummerRow }) =>
          Effect.sync(() => {
            expect(pragueWinterRow.start_time).toBe('18:00:00');
            expect(pragueSummerRow.start_time).toBe('19:00:00');
            expect(lordHoweWinterRow.start_time).toBe('04:00:00');
            expect(lordHoweSummerRow.start_time).toBe('03:30:00');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'A10. end_time NULL stays NULL, start_time still converts, flag still flips ' +
      "(weakly discriminating — say so): this does NOT meaningfully test the migration's CASE, " +
      'since NULL propagates through `start_date + NULL` anyway. What it catches is an ' +
      'implementation that COALESCEs end_time to a literal, or a NOT NULL violation.',
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
    'A11. pre-existing TRUE row is untouched — seeded times_are_team_local = TRUE, ' +
      "start_time '17:00:00' stays '17:00:00'. Distinct from A2 (this row was never converted " +
      'at all). Catches a guard weakened to convert everything.',
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
    'A12. crossing midnight — 22:00/01:00 -> 23:00:00/02:00:00. Both columns convert ' +
      'independently. Catches deriving end_time as start_time + duration, or anchoring end_time ' +
      'on a different date.',
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
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'A13. southern-hemisphere day roll — Australia/Sydney, January, 17:00 -> 04:00:00 (date ' +
      'rolls to the next day, but only the TIME component is stored). Catches a `::timestamp` ' +
      'that leaks the rolled date, or a guard that rejects the roll.',
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
    "A14. cancelled series still converts — status = 'cancelled' -> 18:00:00, true. Catches " +
      "someone adding `AND es.status = 'active'`, which would leave a lying marker.",
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

  // -------------------------------------------------------------------------
  // Statement B
  //
  // Default series/event shape unless a case states otherwise: Prague, start_date 2026-01-06,
  // start_time '17:00:00', end_time '19:00:00' (-> 18:00/20:00 after A). Event: start_at
  // 2027-07-07T17:00:00Z, end_at 2027-07-07T19:00:00Z — a summer occurrence materialized from
  // the winter-stored UTC value, the exact stranded shape the pre-#650 bug produces.
  // -------------------------------------------------------------------------

  const defaultSeries = (teamId: string, createdBy: string) =>
    insertRawSeries({
      teamId,
      createdBy,
      startDate: '2026-01-06',
      startTime: '17:00:00',
      endTime: '19:00:00',
    });

  it.effect(
    'B1. future / active / unmodified event is re-anchored — ' +
      'start_at -> 2027-07-07T16:00:00.000Z, end_at -> 2027-07-07T18:00:00.000Z, ' +
      'personal_messages_dirty_at non-null. Catches Statement B deleted, or a wrong zone on ' +
      'either side of the round trip. Verified in PG.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000001', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) => defaultSeries(setup.teamId, setup.memberId)),
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
    'B2. series_modified = true is left untouched, dirty stamp stays null. Catches a missing ' +
      "`NOT e.series_modified` guard — would clobber a captain's per-occurrence override.",
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000002', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) => defaultSeries(setup.teamId, setup.memberId)),
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
    "B3. status = 'cancelled' is left untouched, dirty stamp stays null. Catches a missing " +
      "`status = 'active'` guard.",
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000003', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) => defaultSeries(setup.teamId, setup.memberId)),
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
    "B4. status = 'started' is left untouched, dirty stamp stays null. Catches a guard written " +
      "as `status <> 'cancelled'` instead of `= 'active'`.",
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000004', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) => defaultSeries(setup.teamId, setup.memberId)),
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
    'B5. past occurrence (series start_date 2020-01-06, event 2020-07-07T17:00:00Z) is left ' +
      'untouched, dirty stamp stays null. Catches a missing `start_at >= now()` guard — would ' +
      'rewrite history.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000005', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2020-01-06',
            startTime: '17:00:00',
            endTime: '19:00:00',
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
    'B6. standalone event (series_id NULL) is left untouched, dirty stamp stays null. Catches a ' +
      '`WHERE` that lost the join.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000006', 'Europe/Prague')),
        Effect.bind('eventId', ({ setup }) =>
          insertRawStandaloneEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
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
    'B7. event of an ALREADY-TRUE series is left untouched — series seeded TRUE with ' +
      "start_time '18:00:00', event at 2027-07-07T16:00:00Z stays exactly there, dirty stamp " +
      'stays null. Both the current Statement B (restricted to `es.id = ANY(convertedIds)`) and ' +
      'the withdrawn, unrestricted form recompute the SAME instant here (2027-07-07T16:00:00Z), ' +
      'so the start_at assertion alone is non-discriminating for this fixture. What actually ' +
      'discriminates is `personalMessagesDirtyAt` staying null: the withdrawn form matches this ' +
      'row (it has no `converted`-id restriction) and unconditionally stamps a fresh dirty_at, ' +
      'while the current, restricted form never matches an already-`TRUE` series at all, so the ' +
      'stamp is never touched. This is the case that forces the `es.id = ANY(convertedIds)` ' +
      'restriction, and the dirty-stamp assertion is what proves it.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000007', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '18:00:00',
            timesAreTeamLocal: true,
          }),
        ),
        Effect.bind('eventId', ({ setup, seriesId }) =>
          insertRawSeriesEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            seriesId,
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
    'B8. NEAR-MIDNIGHT, no day jump (the single most valuable new case) — Prague, ' +
      "start_date '2027-01-05', start_time '22:00' (-> '23:00' after A), event " +
      "'2027-07-06T22:00:00Z' -> '2027-07-06T21:00:00.000Z'. The withdrawn (team-local-date) " +
      "form gives '2027-07-07T21:00:00.000Z' (+23h) because it recovers the occurrence date in " +
      'the TEAM zone (2027-07-08, since 22:00Z is 00:00 next day at +2) instead of the UTC date ' +
      "the event was actually materialized on. Dated 2027 deliberately per the plan's Blocker 2 " +
      "(B's guard is `start_at >= now()`; the original 2026 fixture was already in the past and " +
      'never ran).',
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
    'B9a. end_at handling — series end_time NULL, event end_at non-null -> end_at becomes NULL. ' +
      'Catches this half being silently dropped.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000009', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
            endTime: null,
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
            expect(row.endAtIso).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "B9b. end_at handling — series end_time non-null, event's end_at NULL -> filled in on " +
      "start_at's occurrence date. Catches an end_at anchored on its own (missing) date instead " +
      'of the occurrence date.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000010', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) => defaultSeries(setup.teamId, setup.memberId)),
        Effect.bind('eventId', ({ setup, seriesId }) =>
          insertRawSeriesEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            seriesId,
            startAtIso: '2027-07-07T17:00:00Z',
            endAtIso: null,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            expect(row.startAtIso).toBe('2027-07-07T16:00:00.000Z');
            expect(row.endAtIso).toBe('2027-07-07T18:00:00.000Z');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'B10. RE-RUN IS A PROVABLE NO-OP — capture both start_at AND personal_messages_dirty_at ' +
      'after run 1, run the migration again, both are byte-identical. Catches an unrestricted ' +
      'B that re-stamps dirty_at every run (the withdrawn form fails this timestamp assertion) ' +
      'and a double-shifted start_at.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000011', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) => defaultSeries(setup.teamId, setup.memberId)),
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
        Effect.bind('afterFirstRun', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(() => runMigration()),
        Effect.bind('afterSecondRun', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ afterFirstRun, afterSecondRun }) =>
          Effect.sync(() => {
            expect(afterFirstRun.startAtIso).toBe('2027-07-07T16:00:00.000Z');
            expect(afterFirstRun.personalMessagesDirtyAt).not.toBeNull();
            expect(afterSecondRun.startAtIso).toBe(afterFirstRun.startAtIso);
            expect(afterSecondRun.personalMessagesDirtyAt).toEqual(
              afterFirstRun.personalMessagesDirtyAt,
            );
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "B11. FALL-BACK AMBIGUITY — start_date '2027-07-07', stored start_time '00:30' (-> '02:30' " +
      "after A), event '2027-10-31T00:30:00Z' -> '2027-10-31T01:30:00.000Z' — it MOVES. Pins " +
      'the documented JS/PG disagreement (`applications/server/AGENTS.md` -> "JS and Postgres ' +
      'Disagree On DST-Ambiguous Wall Clocks"): `resolveOccurrenceInstant` (effect DateTime, ' +
      '"compatible") would pick the EARLIER instant (00:30Z), Postgres `AT TIME ZONE` picks the ' +
      'LATER one (01:30Z, asserted here) — a documented one-hour disagreement, not a bug, so a ' +
      'future `AT TIME ZONE` behaviour change is caught here. Anchored on the OTHER DST side on ' +
      'purpose: with start_date in the same offset as the occurrence the row comes back ' +
      'byte-identical to its seed, so the case would pass with Statement B deleted.',
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
        Effect.bind('seriesRow', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ seriesRow, row }) =>
          Effect.sync(() => {
            expect(seriesRow.start_time).toBe('02:30:00');
            expect(row.startAtIso).toBe('2027-10-31T01:30:00.000Z');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "B12. SPRING-FORWARD GAP — start_date '2027-07-07', stored start_time '00:30' " +
      "(-> '02:30' after A), event '2027-03-28T00:30:00Z' -> '2027-03-28T01:30:00.000Z' — it " +
      'MOVES. Here JS and Postgres AGREE (C1 in the plan) — asserted so a future divergence is ' +
      'caught. The original fixture in the withdrawn work was both past-dated AND ' +
      'non-discriminating (the seeded value equalled the asserted value), so it passed green ' +
      'while testing nothing; this fixture actually moves.',
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
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'B13. negative-offset mandate — America/New_York, series 23:00 -> 18:00 after A, event ' +
      "'2027-07-07T23:00:00Z' -> '2027-07-07T22:00:00.000Z'. Catches a zone hard-coded to an " +
      'eastern offset. Verified in PG.',
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
        Effect.bind('seriesRow', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ seriesRow, row }) =>
          Effect.sync(() => {
            expect(seriesRow.start_time).toBe('18:00:00');
            expect(row.startAtIso).toBe('2027-07-07T22:00:00.000Z');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'B14. non-whole-hour mandate, NO-OP BY CONSTRUCTION (weakly discriminating — say so) — ' +
      'Asia/Kathmandu (a fixed offset, never observes DST), series 12:30 -> 18:15 after A, ' +
      "event '2027-07-07T12:30:00Z' -> instant UNCHANGED, but personal_messages_dirty_at " +
      'non-null. A fixed-offset zone can NEVER move under B, so the instant assertion alone ' +
      'would be vacuous (it would pass identically with Statement B deleted, since ' +
      '((instant AT TIME ZONE UTC)::date + local_time) AT TIME ZONE tz round-trips to the same ' +
      'instant for a fixed offset) — the dirty stamp is what proves the row was actually matched ' +
      'and rewritten, and the instant proves the :15 non-whole-hour offset round-trips exactly.',
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
        Effect.bind('seriesRow', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ seriesRow, row }) =>
          Effect.sync(() => {
            expect(seriesRow.start_time).toBe('18:15:00');
            expect(row.startAtIso).toBe('2027-07-07T12:30:00.000Z');
            expect(row.personalMessagesDirtyAt).not.toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'B15 (unique-index collision, Blocker 1) — one series, two occurrences on ADJACENT UTC ' +
      'dates whose converted clock rolls the UTC date BACKWARD: Prague, start_date ' +
      "'2027-01-05' (CET, +1), start_time '23:30:00' -> converted '00:30:00' after A (verified " +
      "in PG). Events at '2027-08-02T21:30:00Z' and '2027-08-03T21:30:00Z' (adjacent UTC " +
      "dates 08-02/08-03) are re-anchored by B, in Prague's SUMMER offset (+2), to " +
      "'2027-08-01T22:30:00Z' and '2027-08-02T22:30:00Z' (verified in PG) — i.e. event 1's OLD " +
      "UTC date (08-02) becomes event 2's NEW UTC date. Without dropping/recreating " +
      '`idx_events_series_date` around Statement B, the non-deferrable per-row unique check on ' +
      "`(series_id, (start_at AT TIME ZONE 'UTC')::date)` can update event 2 to date 08-02 " +
      'while event 1 (not yet updated) still HOLDS date 08-02, raising `duplicate key value ' +
      'violates unique constraint idx_events_series_date` mid-statement, purely as a function of ' +
      'row processing order — even though the FINAL state (08-01 vs 08-02) is unique. This is ' +
      'the case whose absence let a boot-failure-in-production survive six reviews — no other ' +
      'case in this file has a series with more than one occurrence.',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000016', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2027-01-05',
            startTime: '23:30:00',
          }),
        ),
        // PHYSICAL INSERT ORDER IS LOAD-BEARING. After `TRUNCATE`, Postgres's sequential scan for
        // Statement B's `UPDATE` processes rows in heap order, i.e. insertion order. The collision
        // this case exists to catch only fires when the row whose NEW date lands on the OTHER
        // row's still-live OLD date is processed FIRST — here, event2 (08-03) must be inserted
        // (and thus scanned) before event1 (08-02): event2 is updated first, tries to write date
        // 08-02, and event1 (not yet updated) still holds 08-02 — exactly the transient duplicate
        // the index drop/recreate around Statement B is protecting against ("Heap layout
        // decides"). Inserting them in the OTHER order (08-02 then 08-03) makes event1 vacate
        // 08-02 before event2 ever needs it, so the same buggy migration with the index bracket
        // deleted would pass this case anyway — verified against a live index with the
        // migration's exact Statement B shape: 08-02-first gives `UPDATE 2` with no error;
        // 08-03-first raises `duplicate key value violates unique constraint idx_events_series_date`
        // when the index bracket is removed.
        Effect.bind('event2Id', ({ setup, seriesId }) =>
          insertRawSeriesEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            seriesId,
            startAtIso: '2027-08-03T21:30:00Z',
          }),
        ),
        Effect.bind('event1Id', ({ setup, seriesId }) =>
          insertRawSeriesEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            seriesId,
            startAtIso: '2027-08-02T21:30:00Z',
          }),
        ),
        // With only two rows in `events`, Postgres's planner finds it CHEAPER to satisfy
        // Statement B's `e.series_id = es.id` join via a per-series INDEX SCAN on
        // `idx_events_series_date` itself than via a sequential scan — and because that index
        // scan visits rows sorted by the very (series_id, date) key it protects, it happens to
        // process the OLD-dated row (event1, 08-02) before the OTHER row (event2, 08-03)
        // REGARDLESS of physical/heap insertion order, sidestepping the race entirely (verified:
        // `EXPLAIN (VERBOSE)` on this exact join, at this cardinality, shows `Index Scan using
        // idx_events_series_date`, not `Seq Scan`). That access path is an accident of this
        // test's tiny size, not a guarantee — at the migration's real scale (hundreds of series,
        // low thousands of events, `convertedIds` matching MANY series ids in one run) Postgres
        // is far more likely to fall back to a sequential heap scan, making physical insert
        // order the genuine deciding factor. `enable_indexscan`/`enable_bitmapscan = off` (`SET
        // LOCAL`, scoped to one `sql.withTransaction` so both settings and Statement B share the
        // SAME connection) forces that same worst-case, heap-order-driven access path
        // deterministically, so this test's ability to catch the index bracket being deleted
        // does not depend on an incidental planner choice for two rows. This does not change
        // Statement B's SQL or semantics at all — only which access path Postgres uses to
        // execute the unmodified join.
        Effect.tap(() =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.withTransaction(
                Effect.Do.pipe(
                  Effect.tap(() => sql`SET LOCAL enable_indexscan = off`),
                  Effect.tap(() => sql`SET LOCAL enable_bitmapscan = off`),
                  Effect.andThen(() => runMigration()),
                ),
              ),
            ),
          ),
        ),
        Effect.bind('seriesRow', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.bind('row1', ({ event1Id }) => readEventRow(event1Id)),
        Effect.bind('row2', ({ event2Id }) => readEventRow(event2Id)),
        // BLOCKER 2: nothing else in this file touches `pg_indexes`, so deleting the migration's
        // trailing `CREATE UNIQUE INDEX` (and permanently losing production's only
        // duplicate-occurrence backstop) would leave every other case green. Pin the recreated
        // index's definition here, in the one case that actually exercises drop + recreate.
        Effect.bind('indexDef', () => readEventsSeriesDateIndexDef()),
        Effect.tap(({ seriesRow, row1, row2, indexDef }) =>
          Effect.sync(() => {
            expect(seriesRow.start_time).toBe('00:30:00');
            // (2027-08-02T21:30:00Z AT TIME ZONE UTC)::date = 2027-08-02, + TIME '00:30:00' @
            // Europe/Prague (CEST, +2) = 2027-08-01T22:30:00Z — verified in PG.
            expect(row1.startAtIso).toBe('2027-08-01T22:30:00.000Z');
            expect(row2.startAtIso).toBe('2027-08-02T22:30:00.000Z');
            // Final state genuinely unique: distinct UTC dates (row1's new date, 08-01, never
            // collides with row2's new date, 08-02 — the transient collision the index-drop
            // guards against is row2's NEW date landing on row1's still-live OLD date, 08-02).
            expect(row1.startAtIso.slice(0, 10)).not.toBe(row2.startAtIso.slice(0, 10));
            expect(indexDef).toBe(EXPECTED_EVENTS_SERIES_DATE_INDEXDEF);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'B15 (no team_settings row) — team with no settings row; series/event shaped as B1 -> ' +
      're-anchored via the Europe/Prague fallback, same as B1. Catches an inner join in ' +
      'STATEMENT B specifically (A3 only covers Statement A — B has its own subselect).',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970200000000000017')),
        Effect.bind('seriesId', ({ setup }) => defaultSeries(setup.teamId, setup.memberId)),
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

  // -------------------------------------------------------------------------
  // Cross-cutting
  // -------------------------------------------------------------------------

  it.effect(
    'X2. full-run fidelity — one team, six series spanning A1/A7/A8/A9/A12/A14 plus their ' +
      'events, in a single migration run, asserting every row. Catches per-row UPDATE logic ' +
      'that only works when the table has exactly one row (e.g. a mis-correlated subselect).',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('970300000000000001', 'Europe/Prague')),
        // A1-shaped
        Effect.bind('a1', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
          }),
        ),
        // A7-shaped (negative-offset team would differ, but here proves multi-row correlation
        // within one team using a distinct start_time)
        Effect.bind('a7', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '23:00:00',
          }),
        ),
        // A8-shaped: non-whole-hour result even under Prague, distinct start_time
        Effect.bind('a8', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:45:00',
          }),
        ),
        // A9-shaped: same start_time as a1, different start_date -> different anchor result
        Effect.bind('a9', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-07-07',
            startTime: '17:00:00',
          }),
        ),
        // A12-shaped: crosses midnight
        Effect.bind('a12', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '22:00:00',
            endTime: '01:00:00',
          }),
        ),
        // A14-shaped: cancelled
        Effect.bind('a14', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
            status: 'cancelled',
          }),
        ),
        Effect.bind('a1Event', ({ setup, a1 }) =>
          insertRawSeriesEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            seriesId: a1,
            startAtIso: '2027-07-07T17:00:00Z',
          }),
        ),
        Effect.bind('a9Event', ({ setup, a9 }) =>
          insertRawSeriesEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            seriesId: a9,
            startAtIso: '2027-07-07T17:00:00Z',
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('a1Row', ({ a1 }) => readSeriesRow(a1)),
        Effect.bind('a7Row', ({ a7 }) => readSeriesRow(a7)),
        Effect.bind('a8Row', ({ a8 }) => readSeriesRow(a8)),
        Effect.bind('a9Row', ({ a9 }) => readSeriesRow(a9)),
        Effect.bind('a12Row', ({ a12 }) => readSeriesRow(a12)),
        Effect.bind('a14Row', ({ a14 }) => readSeriesRow(a14)),
        Effect.bind('a1EventRow', ({ a1Event }) => readEventRow(a1Event)),
        Effect.bind('a9EventRow', ({ a9Event }) => readEventRow(a9Event)),
        Effect.tap(({ a1Row, a7Row, a8Row, a9Row, a12Row, a14Row, a1EventRow, a9EventRow }) =>
          Effect.sync(() => {
            expect(a1Row.start_time).toBe('18:00:00');
            expect(a7Row.start_time).toBe('00:00:00'); // Prague, 23:00 winter -> +1 -> 00:00
            expect(a8Row.start_time).toBe('18:45:00');
            expect(a9Row.start_time).toBe('19:00:00'); // July anchor, differs from a1's 18:00
            expect(a12Row.start_time).toBe('23:00:00');
            expect(a12Row.end_time).toBe('02:00:00');
            expect(a14Row.start_time).toBe('18:00:00');
            expect(a14Row.times_are_team_local).toBe(true);
            // a1's series is winter-anchored (18:00); its summer event is re-anchored -1h.
            expect(a1EventRow.startAtIso).toBe('2027-07-07T16:00:00.000Z');
            // a9's series is summer-anchored (19:00); its summer event needs no shift at all
            // (19:00 Prague summer occurrence recovered from a 17:00Z stranded value = 17:00Z).
            expect(a9EventRow.startAtIso).toBe('2027-07-07T17:00:00.000Z');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
