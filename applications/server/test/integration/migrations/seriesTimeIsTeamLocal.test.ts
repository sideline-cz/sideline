// Review finding (DST flaky-test cleanup): migration
// `1791600000_series_time_is_team_local.ts` had no integration test at all —
// only the JS-side resolver (`test/utils/seriesOccurrence.test.ts`) and the
// mocked unit tests in `EventSeries.test.ts` covered any of this behaviour,
// neither of which exercises the actual SQL against a real Postgres.
//
// Follows the exact pattern of `anchorAllDayToTeamMidnight.test.ts` and
// `allDayDeferralStampsBackfill.test.ts`: the migration module is imported
// directly and re-run against hand-seeded "legacy" rows (raw INSERT,
// bypassing the repositories, which never produce the pre-migration shape
// this migration exists to fix).
//
// Every literal instant asserted below was verified directly against a real
// Postgres 17 instance (`packages/migrations/src/before/
// 1791600000_series_time_is_team_local.ts`'s own `AT TIME ZONE` expressions),
// not hand-computed.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import seriesTimeIsTeamLocal from '@sideline/migrations/before/1791600000_series_time_is_team_local';
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
// Seed helpers (mirrors anchorAllDayToTeamMidnight.test.ts)
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
        name: 'Series Time Migration Test Team',
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
 * Creates a user + team + team member, and OPTIONALLY a `team_settings` row
 * (with an arbitrary, possibly INVALID, timezone string — this repository
 * call performs no validation; only the HTTP API layer's
 * `isValidIanaTimezone` does, and a hand-edited/legacy row bypasses that
 * entirely). Passing `timezone: undefined` leaves the team WITHOUT a
 * `team_settings` row at all.
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
      // TeamMembersRepository.addMember's return type isn't re-exported here;
      // mirrors the `(tm as any).id` cast already used elsewhere for the same call.
      memberId: (member as unknown as { id: string }).id,
    })),
  );

/**
 * Raw INSERT of an `event_series` row, bypassing `EventSeriesRepository`
 * entirely — this migration's whole job is converting rows that predate its
 * own `times_are_team_local` column, which nothing written through the
 * repository can produce (the column defaults to FALSE, matching the
 * pre-migration/pre-write-path shape, so no override is needed here).
 */
const insertRawSeries = (params: {
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

describe('migration 1791600000 — series times are team-local wall clock, not UTC', () => {
  it.effect(
    "1. IDEMPOTENCE (times_are_team_local guard) — running the migration TWICE shifts a Prague winter series' 17:00 storage to 18:00 exactly ONCE, not twice",
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('960100000000000001', 'Europe/Prague')),
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
            // (DATE '2026-01-06' + TIME '17:00:00') AT TIME ZONE 'UTC' AT TIME ZONE
            // 'Europe/Prague' — verified directly against Postgres 17.
            expect(afterFirstRun.start_time).toBe('18:00:00');
            expect(afterFirstRun.end_time).toBe('20:00:00');
            expect(afterFirstRun.times_are_team_local).toBe(true);
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('afterSecondRun', ({ seriesId }) => readSeriesRow(seriesId)),
        Effect.tap(({ afterFirstRun, afterSecondRun }) =>
          Effect.sync(() => {
            // A second run must NOT shift this again (18:00 -> 19:00, guarded by
            // `WHERE NOT es.times_are_team_local`) — the single most important case
            // in this file.
            expect(afterSecondRun.start_time).toBe(afterFirstRun.start_time);
            expect(afterSecondRun.end_time).toBe(afterFirstRun.end_time);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    '2. A team with NO team_settings row still converts, via the COALESCE fallback to Europe/Prague — proving the timezone lookup is a correlated scalar subselect, not an inner join that would silently skip it',
    () =>
      Effect.Do.pipe(
        // No timezone passed → no team_settings row is created for this team at all.
        Effect.bind('setup', () => setupTeam('960100000000000002')),
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
            // Same result as case 1's Europe/Prague fixture (the COALESCE
            // fallback) — an INNER JOIN on team_settings would have left this
            // series completely unconverted at '17:00:00' instead.
            expect(row.start_time).toBe('18:00:00');
            expect(row.times_are_team_local).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    '3. A team with an INVALID team_settings.timezone does not abort the migration — falls back to Europe/Prague',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('960100000000000003', 'Mars/Olympus')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
          }),
        ),
        // The whole point of this case: this must not throw
        // `ERROR: time zone "Mars/Olympus" not recognized` and abort the
        // migration (and, in production, server boot).
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
    '4. A SOUTHERN-hemisphere team (Australia/Sydney, local summer in January) — the day-of-month rollover from the AT TIME ZONE conversion is silently absorbed by the ::time cast, exactly as intended',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('960100000000000004', 'Australia/Sydney')),
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
            // (DATE '2026-01-06' + TIME '17:00:00') AT TIME ZONE 'UTC' AT TIME ZONE
            // 'Australia/Sydney' = 2026-01-07 04:00:00 (AEDT, +11, January is
            // Sydney's summer) — verified directly against Postgres 17. The date
            // rolls to the 7th, but only the TIME component is stored.
            expect(row.start_time).toBe('04:00:00');
            expect(row.times_are_team_local).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    '5. Statement B re-anchors a stranded, future, active, UNMODIFIED series event materialized under the old UTC-literal bug (Prague, winter series time applied to a summer occurrence)',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('960100000000000005', 'Europe/Prague')),
        Effect.bind('seriesId', ({ setup }) =>
          insertRawSeries({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startDate: '2026-01-06',
            startTime: '17:00:00',
          }),
        ),
        // The pre-migration `EventHorizonCron` built this as `${dateStr}T${start_time}Z` —
        // a SUMMER occurrence materialized using the WINTER-stored '17:00:00' as a
        // literal UTC time-of-day. That is exactly the drift the migration fixes.
        Effect.bind('eventId', ({ setup, seriesId }) =>
          insertRawSeriesEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            seriesId,
            startAtIso: '2027-07-07T17:00:00Z',
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            // ((TIMESTAMPTZ '2027-07-07T17:00:00Z' AT TIME ZONE 'Europe/Prague')::date
            //   + TIME '18:00:00') AT TIME ZONE 'Europe/Prague' = 2027-07-07T16:00:00Z —
            // verified directly against Postgres 17. One hour EARLIER than the
            // stranded value, matching the documented bug (an hour late in summer).
            expect(row.startAtIso).toBe('2027-07-07T16:00:00.000Z');
            expect(row.personalMessagesDirtyAt).not.toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('6. Statement B leaves a HAND-EDITED (series_modified) occurrence untouched', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () => setupTeam('960100000000000006', 'Europe/Prague')),
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

  it.effect("7. Statement B leaves a CANCELLED (status <> 'active') occurrence untouched", () =>
    Effect.Do.pipe(
      Effect.bind('setup', () => setupTeam('960100000000000007', 'Europe/Prague')),
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

  it.effect('8. Statement B leaves a PAST (start_at < now()) occurrence untouched', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () => setupTeam('960100000000000008', 'Europe/Prague')),
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
});
