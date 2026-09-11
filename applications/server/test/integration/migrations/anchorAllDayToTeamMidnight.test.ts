// TDD mode — PR 3c of the all-day-Discord-start-time plan (§13, §7.11).
//
// This is the highest-consequence migration in the plan: it rewrites the
// `start_at`/`end_at` of every EXISTING all-day `events` row from the
// pre-PR-3 noon-UTC sentinel to the team-local-midnight anchor, in place, on
// live production data. `packages/migrations/src/before/1791400000_anchor_
// all_day_to_team_midnight.ts` does not exist yet — §13's table names it as a
// PLACEHOLDER id, to be re-picked as `> max(existing)` at PR-3c's OWN merge
// time (packages/migrations/AGENTS.md, §13's warning box). `1791400000` is
// the id stated as "next free" at the time this test was written; the
// developer MUST re-run `ls -1 packages/migrations/src/before | sort | tail
// -1` before creating the file and rename both the file and this test's
// import if a higher id has landed since.
//
// ⚠ TWO-LAYERED RED STATE, same shape as `EventsRepository.allDayAnchored
// .test.ts` (PR 3) and `teamSettingsReanchor.test.ts`:
//   1. Until the migration file exists AND `packages/migrations` is rebuilt
//      (`pnpm build` — its `dist/package.json` exports map is generated per
//      file, root AGENTS.md "Run `pnpm build` first (migrations package must
//      be compiled)"), the deep import below fails module resolution and
//      EVERY test in this file errors at load time. That is not yet a
//      statement about the migration's SQL — it is the "the file doesn't
//      exist" layer.
//   2. Once the import resolves, the suite tests the migration's actual
//      behaviour: whether the guard is `all_day_anchored` (correct) or a
//      time-of-day heuristic (wrong at UTC+12, case 5/6), whether the join is
//      a correlated subselect or an `UPDATE ... FROM` inner join (wrong for
//      teams with no settings row, case 3), and idempotence (case 5, "the
//      single most dangerous thing to omit" per §13.1).
//
// This is a Postgres integration test (testcontainers, see
// test/integration/globalSetup.ts). The migration module is imported and run
// DIRECTLY (not merely applied once by globalSetup) because globalSetup runs
// every migration against an EMPTY `events` table — the interesting behaviour
// only appears once we seed pre-PR-3 "legacy" rows (raw INSERT, bypassing
// `EventsRepository`, whose insert/update already stamp
// `all_day_anchored = all_day` per PR 3 — see EventsRepository.ts:209-210)
// and then re-run the migration's own Effect against them, exactly as an
// operator re-running §13.1 "by hand" would (§13.4, §17.2).
//
// Every literal instant asserted below was verified directly against a real
// Postgres 17 instance (`date_trunc('day', ts AT TIME ZONE 'UTC') AT TIME
// ZONE <tz>`), not hand-computed — see the case-by-case comments.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import anchorAllDayToTeamMidnight from '@sideline/migrations/before/1791400000_anchor_all_day_to_team_midnight';
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
// Seed helpers
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
        name: 'Anchor Migration Test Team',
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
 * Passing `timezone: undefined` deliberately leaves the team WITHOUT a
 * `team_settings` row at all — case 3's fixture, and the fixture that would
 * be silently excluded by an `UPDATE ... FROM team_settings` inner join
 * (§13.1, §4.4.4).
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
      // mirrors the `(tm as any).id` cast already used in
      // EventsRepository.allDayAnchored.test.ts for the same repository call.
      memberId: (member as unknown as { id: string }).id,
    })),
  );

/**
 * Raw INSERT, bypassing `EventsRepository` entirely — the repository's
 * insert/update ALREADY stamp `all_day_anchored = all_day` (PR 3,
 * EventsRepository.ts:209-210, :244-245), so it is structurally incapable of
 * producing the "legacy" fixture this migration exists to fix: an
 * `all_day = TRUE` row with `all_day_anchored = FALSE` sitting at the
 * noon-UTC sentinel. Only a raw INSERT can create that pre-PR-3 shape.
 */
const insertRawEvent = (params: {
  teamId: string;
  createdBy: string;
  startAtIso: string;
  endAtIso?: string | null;
  allDay: boolean;
  allDayAnchored: boolean;
  status?: string;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ id: string }>(`
        INSERT INTO events (team_id, event_type, title, start_at, end_at, created_by, all_day, all_day_anchored, status)
        VALUES (
          '${params.teamId}', 'tournament', 'Legacy all-day event',
          '${params.startAtIso}'::timestamptz,
          ${params.endAtIso == null ? 'NULL' : `'${params.endAtIso}'::timestamptz`},
          '${params.createdBy}', ${params.allDay}, ${params.allDayAnchored},
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

/** Reads back the columns the migration touches, decoded as ISO strings so
 * assertions compare exact instants rather than driver-specific shapes. */
const readEventRow = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{
        start_at: Date;
        end_at: Date | null;
        all_day_anchored: boolean;
        all_day: boolean;
      }>(`SELECT start_at, end_at, all_day_anchored, all_day FROM events WHERE id = '${id}'`),
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) throw new Error(`event ${id} not found`);
      return {
        startAtIso: row.start_at.toISOString(),
        endAtIso: row.end_at === null ? null : row.end_at.toISOString(),
        allDayAnchored: row.all_day_anchored,
        allDay: row.all_day,
      };
    }),
  );

/** Runs the migration's own Effect against the test database. Safe to
 * reference more than once in the same chain — each reference is a fresh
 * execution, exactly like an operator re-running §13.1 by hand. */
const runMigration = () => anchorAllDayToTeamMidnight;

// ---------------------------------------------------------------------------
// §7.11 cases 1–10
// ---------------------------------------------------------------------------

describe('migration 1791400000 — anchor existing all-day events to team-local midnight (PR 3c, plan §13)', () => {
  it.effect(
    '1. Prague, summer row at the noon-UTC sentinel → team-local midnight (CEST, +2). Verified: 2026-07-15T12:00:00Z → 2026-07-14T22:00:00Z',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('950100000000000001', 'Europe/Prague')),
        Effect.bind('eventId', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            endAtIso: '2026-07-17T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            expect(row.startAtIso).toBe('2026-07-14T22:00:00.000Z');
            expect(row.endAtIso).toBe('2026-07-16T22:00:00.000Z');
            expect(row.allDayAnchored).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    '2. Prague, winter row → team-local midnight (CET, +1). Verified: 2026-01-15T12:00:00Z → 2026-01-14T23:00:00Z',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('950100000000000002', 'Europe/Prague')),
        Effect.bind('eventId', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: '2026-01-15T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            expect(row.startAtIso).toBe('2026-01-14T23:00:00.000Z');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    '3. Team with NO team_settings row falls back to Europe/Prague and is NOT skipped (correlated subselect, not an inner join)',
    () =>
      Effect.Do.pipe(
        // No timezone passed → no team_settings row is created for this team at all.
        Effect.bind('setup', () => setupTeam('950100000000000003')),
        Effect.bind('eventId', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            // Same instant as case 1 (Europe/Prague, the COALESCE fallback).
            // An `UPDATE ... FROM team_settings` INNER join would have left
            // this row completely untouched at the noon-UTC sentinel instead.
            expect(row.startAtIso).toBe('2026-07-14T22:00:00.000Z');
            expect(row.allDayAnchored).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('4. A TIMED row is untouched by the migration', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () => setupTeam('950100000000000004', 'Europe/Prague')),
      Effect.bind('eventId', ({ setup }) =>
        insertRawEvent({
          teamId: setup.teamId,
          createdBy: setup.memberId,
          startAtIso: '2026-07-15T09:00:00Z',
          endAtIso: '2026-07-15T10:30:00Z',
          allDay: false,
          allDayAnchored: false,
        }),
      ),
      Effect.tap(() => runMigration()),
      Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(row.startAtIso).toBe('2026-07-15T09:00:00.000Z');
          expect(row.endAtIso).toBe('2026-07-15T10:30:00.000Z');
          expect(row.allDay).toBe(false);
          expect(row.allDayAnchored).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    "5. IDEMPOTENCE — running the migration twice does not shift a row twice. Highest-value case in the file (§13.1's box).",
    () =>
      Effect.Do.pipe(
        // Three teams, not one — a Prague-only fixture set CANNOT observe the
        // UTC+12 hole in a naive time-of-day guard (`(start_at AT TIME ZONE
        // 'UTC')::time = TIME '12:00:00'`): a +12 team's MIGRATED row lands
        // back on exactly `12:00:00Z`, so that guard re-matches its own
        // output and a second run shifts it another day back. The real guard
        // (`all_day_anchored`) does not have this hole, which is the whole
        // point of this case.
        Effect.bind('prague', () => setupTeam('950100000000000501', 'Europe/Prague')),
        Effect.bind('newYork', () => setupTeam('950100000000000502', 'America/New_York')),
        // ⚠ Pinned to 2026-07-15, an NZST (not NZDT) date. Auckland is NZDT
        // (+13) from late September to early April; a July-vs-January copy of
        // this fixture at an NZDT date would put the row at 11:00Z after the
        // first run, the naive guard would NOT re-match, and this case would
        // pass VACUOUSLY while proving nothing (§7.11 case 5's warning). Do
        // not "harmonise" this date with the other two teams.
        Effect.bind('auckland', () => setupTeam('950100000000000503', 'Pacific/Auckland')),
        Effect.bind('pragueEventId', ({ prague }) =>
          insertRawEvent({
            teamId: prague.teamId,
            createdBy: prague.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.bind('newYorkEventId', ({ newYork }) =>
          insertRawEvent({
            teamId: newYork.teamId,
            createdBy: newYork.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.bind('aucklandEventId', ({ auckland }) =>
          insertRawEvent({
            teamId: auckland.teamId,
            createdBy: auckland.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('afterFirstRun', ({ pragueEventId, newYorkEventId, aucklandEventId }) =>
          Effect.all({
            prague: readEventRow(pragueEventId),
            newYork: readEventRow(newYorkEventId),
            auckland: readEventRow(aucklandEventId),
          }),
        ),
        Effect.tap(({ afterFirstRun }) =>
          Effect.sync(() => {
            expect(afterFirstRun.prague.startAtIso).toBe('2026-07-14T22:00:00.000Z');
            expect(afterFirstRun.newYork.startAtIso).toBe('2026-07-15T04:00:00.000Z');
            // The Auckland row lands BACK on 12:00:00Z — the exact instant a
            // naive time-of-day guard would re-match.
            expect(afterFirstRun.auckland.startAtIso).toBe('2026-07-14T12:00:00.000Z');
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('afterSecondRun', ({ pragueEventId, newYorkEventId, aucklandEventId }) =>
          Effect.all({
            prague: readEventRow(pragueEventId),
            newYork: readEventRow(newYorkEventId),
            auckland: readEventRow(aucklandEventId),
          }),
        ),
        Effect.tap(({ afterFirstRun, afterSecondRun }) =>
          Effect.sync(() => {
            expect(afterSecondRun.prague.startAtIso).toBe(afterFirstRun.prague.startAtIso);
            expect(afterSecondRun.newYork.startAtIso).toBe(afterFirstRun.newYork.startAtIso);
            // The case that fails first under an unguarded/naive-guard
            // migration: unguarded, this would be one day earlier than
            // `afterFirstRun.auckland.startAtIso`.
            expect(afterSecondRun.auckland.startAtIso).toBe(afterFirstRun.auckland.startAtIso);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "6. An already-anchored row present BEFORE the migration is untouched — including a +12 team's row sitting at 12:00:00Z (the row a naive guard would re-migrate)",
    () =>
      Effect.Do.pipe(
        Effect.bind('auckland', () => setupTeam('950100000000000006', 'Pacific/Auckland')),
        Effect.bind('eventId', ({ auckland }) =>
          insertRawEvent({
            teamId: auckland.teamId,
            createdBy: auckland.memberId,
            // The value an already-migrated Auckland row sits at (case 5) —
            // seeded directly with all_day_anchored = TRUE, as if PR 3's
            // write path (or a previous run of this migration) had already
            // produced it.
            startAtIso: '2026-07-14T12:00:00Z',
            allDay: true,
            allDayAnchored: true,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            expect(row.startAtIso).toBe('2026-07-14T12:00:00.000Z');
            expect(row.allDayAnchored).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('7. end_at NULL stays NULL', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () => setupTeam('950100000000000007', 'Europe/Prague')),
      Effect.bind('eventId', ({ setup }) =>
        insertRawEvent({
          teamId: setup.teamId,
          createdBy: setup.memberId,
          startAtIso: '2026-07-15T12:00:00Z',
          endAtIso: null,
          allDay: true,
          allDayAnchored: false,
        }),
      ),
      Effect.tap(() => runMigration()),
      Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(row.startAtIso).toBe('2026-07-14T22:00:00.000Z');
          expect(row.endAtIso).toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    '8. DST at local midnight (GAP) — America/Santiago, 2026-09-06T00:00 local does not exist. Migration resolves forward to 01:00 local, matching the write path exactly (§10.1, §13.5). Verified: 2026-09-06T12:00:00Z → 2026-09-06T04:00:00Z',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('950100000000000008', 'America/Santiago')),
        Effect.bind('eventId', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: '2026-09-06T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('row', ({ eventId }) => readEventRow(eventId)),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            // This is the exact literal §7.10 case 13 asserts for the WRITE
            // PATH's Effect `setParts` on the same input — the point of this
            // case is that Postgres agrees, not merely that some date came out.
            expect(row.startAtIso).toBe('2026-09-06T04:00:00.000Z');
          }),
        ),
        Effect.bind('localTime', ({ eventId }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.unsafe<{ local_time: string }>(
                `SELECT (start_at AT TIME ZONE 'America/Santiago')::time::text AS local_time FROM events WHERE id = '${eventId}'`,
              ),
            ),
            Effect.map((rows) => rows[0]?.local_time),
          ),
        ),
        Effect.tap(({ localTime }) =>
          Effect.sync(() => {
            // Cosmetic per §10.1: the date component is still correct even
            // though the anchored instant lands at 01:00, not 00:00, local.
            // This is exactly what §13.5's `not_local_midnight` filter is
            // built to surface (and is expected to be non-zero for this row).
            expect(localTime).toBe('01:00:00');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    '9. all_day_anchored is TRUE for every all-day row after the run, and untouched (FALSE) for timed rows',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('950100000000000009', 'Europe/Prague')),
        Effect.bind('allDayId', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.bind('timedId', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: '2026-07-15T09:00:00Z',
            allDay: false,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('rows', ({ allDayId, timedId }) =>
          Effect.all({ allDay: readEventRow(allDayId), timed: readEventRow(timedId) }),
        ),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            expect(rows.allDay.allDayAnchored).toBe(true);
            expect(rows.timed.allDayAnchored).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "10. AMBIGUOUS local midnight (America/Havana) — assert the DIVERGENCE between engines, not equality (§11.5(d)). Postgres AT TIME ZONE picks the SECOND instant (−05); Effect setParts (write path, §7.10) picks the FIRST (−04). They are exactly one hour apart, and §13.5's not_local_midnight filter is blind to BOTH.",
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('950100000000000010', 'America/Havana')),
        Effect.bind('migratedId', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: '2026-11-01T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('migratedRow', ({ migratedId }) => readEventRow(migratedId)),
        Effect.tap(({ migratedRow }) =>
          Effect.sync(() => {
            // Postgres's actual answer for this migration — verified against
            // a real Postgres 17 instance, NOT hand-computed.
            expect(migratedRow.startAtIso).toBe('2026-11-01T05:00:00.000Z');
          }),
        ),
        // Do NOT assert this equals the migrated value — see the box above.
        // This is the write path's documented literal (§7.11 case 10, §11.5(d),
        // measured at effect@4.0.0-beta.40's `DateTime.setParts`), asserted here
        // as a plain constant so a future reader sees the exact ≤1h divergence
        // this residual accepts, rather than an unexplained magic number.
        Effect.bind('effectWritePathLiteral', ({ migratedRow }) =>
          Effect.sync(() => {
            const effectLiteral = '2026-11-01T04:00:00.000Z';
            const diffMs =
              new Date(migratedRow.startAtIso).getTime() - new Date(effectLiteral).getTime();
            expect(diffMs).toBe(60 * 60 * 1000);
            return effectLiteral;
          }),
        ),
        // Simulates the row the WRITE PATH would have produced for the same
        // input (already anchored, so the migration itself would never touch
        // it) — inserted directly so we can exercise §13.5's verification
        // query against both engines' answers for the identical wall-clock
        // date, in the same test.
        Effect.bind('writePathId', ({ setup, effectWritePathLiteral }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            startAtIso: effectWritePathLiteral,
            allDay: true,
            allDayAnchored: true,
          }),
        ),
        Effect.bind('notLocalMidnightCounts', ({ migratedId, writePathId }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.unsafe<{ id: string; not_local_midnight: boolean }>(`
                SELECT e.id,
                       (e.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::time <> TIME '00:00:00'
                         AS not_local_midnight
                FROM events e
                LEFT JOIN team_settings ts ON ts.team_id = e.team_id
                WHERE e.id IN ('${migratedId}', '${writePathId}')
              `),
            ),
          ),
        ),
        Effect.tap(({ notLocalMidnightCounts }) =>
          Effect.sync(() => {
            // §13.5's check is structurally blind to the ambiguous-midnight
            // divergence: BOTH the Postgres-migrated value and the
            // Effect-write-path value read back as local time 00:00:00, so
            // neither is flagged — "there is nothing wrong to find" (§11.5(d)).
            expect(notLocalMidnightCounts).toHaveLength(2);
            for (const row of notLocalMidnightCounts) {
              expect(row.not_local_midnight).toBe(false);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// §13.4 — the pre-deploy check, and why the guard is load-bearing
// ---------------------------------------------------------------------------

describe('§13.4 pre-deploy check — must return 0 after a successful run, because it is guarded the same way the migration is', () => {
  it.effect(
    'returns 0 once every all-day row is anchored, even though PR-3-anchored rows already exist in the table',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('950100000000001101', 'Europe/Prague')),
        // A legacy, not-yet-migrated row, safely in the past relative to
        // whenever this test actually runs (relative interval — not a fixed
        // calendar literal — so the assertion below is robust to real CI run
        // dates rather than pinned to 2026).
        Effect.bind('legacyEventId', ({ setup }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.unsafe<{ id: string }>(`
                INSERT INTO events (team_id, event_type, title, start_at, created_by, all_day, all_day_anchored, status)
                VALUES (
                  '${setup.teamId}', 'tournament', 'Legacy past all-day event',
                  date_trunc('day', now() - interval '10 days') + interval '12 hours',
                  '${setup.memberId}', TRUE, FALSE, 'active'
                )
                RETURNING id
              `),
            ),
            Effect.map((rows) => rows[0]?.id),
          ),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('guardedCount', () =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.unsafe<{ count: string }>(`
                SELECT count(*) FROM events e
                LEFT JOIN team_settings ts ON ts.team_id = e.team_id
                WHERE e.all_day = TRUE
                  AND NOT e.all_day_anchored
                  AND e.status = 'active'
                  AND date_trunc('day', e.start_at AT TIME ZONE 'UTC')
                        AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague') <= now()
              `),
            ),
            Effect.map((rows) => Number(rows[0]?.count ?? -1)),
          ),
        ),
        Effect.tap(({ guardedCount }) =>
          Effect.sync(() => {
            expect(guardedCount).toBe(0);
          }),
        ),
        // Contrast: the earlier draft's query, which OMITTED `AND NOT
        // e.all_day_anchored`. Once the legacy row above is anchored by the
        // migration, it becomes a correctly-anchored, past-dated, active
        // all-day row indistinguishable (to this unguarded query) from a
        // brand-new PR-3 write — and it never clears, because it will always
        // remain in the past. This is the "returns non-zero forever" failure
        // §13.4's box warns about.
        Effect.bind('unguardedCount', () =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.unsafe<{ count: string }>(`
                SELECT count(*) FROM events e
                LEFT JOIN team_settings ts ON ts.team_id = e.team_id
                WHERE e.all_day = TRUE
                  AND e.status = 'active'
                  AND date_trunc('day', e.start_at AT TIME ZONE 'UTC')
                        AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague') <= now()
              `),
            ),
            Effect.map((rows) => Number(rows[0]?.count ?? -1)),
          ),
        ),
        Effect.tap(({ unguardedCount }) =>
          Effect.sync(() => {
            expect(unguardedCount).toBeGreaterThanOrEqual(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// §13.5 — the verification query
// ---------------------------------------------------------------------------

describe('§13.5 verification query — unmigrated = 0 after a successful run', () => {
  it.effect(
    'unmigrated = 0, not_local_midnight = 0 and end_not_local_midnight = 0 for ordinary (non-DST-at-midnight) zones',
    () =>
      Effect.Do.pipe(
        Effect.bind('prague', () => setupTeam('950100000000001201', 'Europe/Prague')),
        Effect.bind('newYork', () => setupTeam('950100000000001202', 'America/New_York')),
        Effect.bind('pragueEventId', ({ prague }) =>
          insertRawEvent({
            teamId: prague.teamId,
            createdBy: prague.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            endAtIso: '2026-07-16T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.bind('newYorkEventId', ({ newYork }) =>
          insertRawEvent({
            teamId: newYork.teamId,
            createdBy: newYork.memberId,
            startAtIso: '2026-07-15T12:00:00Z',
            allDay: true,
            allDayAnchored: false,
          }),
        ),
        Effect.tap(() => runMigration()),
        Effect.bind('verification', () =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.unsafe<{
                unmigrated: string;
                not_local_midnight: string;
                end_not_local_midnight: string;
                total: string;
              }>(`
                SELECT count(*) FILTER (WHERE NOT e.all_day_anchored) AS unmigrated,
                       count(*) FILTER (WHERE (e.start_at AT TIME ZONE COALESCE(ts.timezone,'Europe/Prague'))::time
                                              <> TIME '00:00:00') AS not_local_midnight,
                       count(*) FILTER (WHERE e.end_at IS NOT NULL
                                          AND (e.end_at AT TIME ZONE COALESCE(ts.timezone,'Europe/Prague'))::time
                                              <> TIME '00:00:00') AS end_not_local_midnight,
                       count(*) AS total
                FROM events e
                LEFT JOIN team_settings ts ON ts.team_id = e.team_id
                WHERE e.all_day = TRUE
              `),
            ),
          ),
        ),
        Effect.tap(({ verification, pragueEventId, newYorkEventId }) =>
          Effect.sync(() => {
            // Keep the seeded ids alive in the assertion so a future refactor
            // that seeds them but forgets to migrate does not go unnoticed.
            expect(pragueEventId).toBeDefined();
            expect(newYorkEventId).toBeDefined();
            const row = verification[0];
            if (!row) throw new Error('verification query returned no row');
            expect(Number(row.unmigrated)).toBe(0);
            expect(Number(row.not_local_midnight)).toBe(0);
            expect(Number(row.end_not_local_midnight)).toBe(0);
            expect(Number(row.total)).toBe(2);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
