// TDD mode — PR 3b of the all-day-Discord-start-time plan (§11.2, §11.3, §17).
//
// `EventWithDetails` (the row behind `findEventsByTeamId`/`findEventByIdWithDetails`,
// which feed `EventApi.EventInfo`/`EventDetail`) does not carry `start_date`/`end_date`
// yet — every test below is expected to fail (`undefined` where a string or `Option`
// is asserted) until the developer:
//   1. adds `LEFT JOIN team_settings ts ON ts.team_id = e.team_id` to both queries
//      (never an inner join — a team with no `team_settings` row must still get a row,
//      falling back to `Europe/Prague`, §11.2/§4.4.4);
//   2. projects
//      `(e.start_at AT TIME ZONE COALESCE(ts.timezone,'Europe/Prague'))::date::text AS start_date`
//      and the `COALESCE(e.end_at, e.start_at)` equivalent for `end_date` — the
//      `::date::text` cast is mandatory (a bare `::date` comes back as a JS `Date`,
//      which `Schema.String` rejects, per §11.2's `WeeklySummaryRepository.ts:344-345`
//      precedent);
//   3. adds `start_date`/`end_date` to `EventWithDetails`.
//
// These are Effect-SQL integration tests against a real Postgres (via testcontainers,
// see test/integration/globalSetup.ts) — the derived-date projection is SQL, not TS,
// so a mock can't catch a malformed cast or a wrong join type.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamSettingsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers (mirrors EventsRepository.test.ts's seeding pattern)
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
        guild_id: guildId,
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

const insertAllDayEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  startAtIso: string,
  title = 'All-day event',
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'tournament',
        title,
        description: Option.none(),
        startAt: DateTime.makeUnsafe(startAtIso),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
        allDay: true,
      }),
    ),
  );

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventsRepository — start_date/end_date derived projection (PR 3b)', () => {
  // Item 1 — anchor-neutrality. The team is at +2 (Prague, well within [-12, +12)),
  // so under the still-in-place noon-UTC sentinel, the derived team-local date must
  // equal the UTC date — i.e. render exactly what today's code renders. This is the
  // property that makes PR 3b safe to ship ahead of the anchor move (§17).
  it.effect(
    'anchor-neutral: Prague team, noon-UTC sentinel → start_date equals the UTC calendar date',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('310000000000000001', 'owner-1')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('311010101010101011' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('inserted', ({ team, tm }) =>
          insertAllDayEvent(
            team.id,
            (tm as any).id as TeamMember.TeamMemberId,
            '2026-07-15T12:00:00Z',
          ),
        ),
        Effect.bind('found', ({ inserted }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
          ),
        ),
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            const row = Option.getOrThrow(found) as any;
            expect(row.start_date).toMatch(DATE_ONLY_RE);
            expect(row.start_date).toBe('2026-07-15');
            expect(row.end_date).toBe('2026-07-15');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Item 2 — the derived projection itself, for a team at a NEGATIVE offset where
  // the noon-UTC sentinel still maps to the same UTC calendar date (still
  // anchor-neutral — New York is well within [-12, +12)).
  it.effect(
    'derived projection: America/New_York team → start_date is the team-local calendar date, as a string',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('310000000000000002', 'owner-2')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('311010101010101012' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'America/New_York')),
        Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('inserted', ({ team, tm }) =>
          insertAllDayEvent(
            team.id,
            (tm as any).id as TeamMember.TeamMemberId,
            '2026-07-15T12:00:00Z',
          ),
        ),
        Effect.bind('found', ({ inserted }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
          ),
        ),
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            const row = Option.getOrThrow(found) as any;
            // Noon UTC = 08:00 America/New_York — same calendar date either way.
            expect(row.start_date).toBe('2026-07-15');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Item 3 — a team with NO team_settings row at all must still get a start_date,
  // falling back to Europe/Prague. An inner join (or `UPDATE ... FROM team_settings`)
  // would silently exclude this row — this test is the guard against that (§11.2,
  // §4.4.4's argument, explicitly re-flagged for the read path by the plan).
  it.effect(
    'team with NO team_settings row → falls back to Europe/Prague, and the row is NOT dropped',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('310000000000000003', 'owner-3')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('311010101010101013' as Discord.Snowflake, ownerId),
        ),
        // Deliberately no setTeamTimezone call — no team_settings row exists for this team.
        Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('inserted', ({ team, tm }) =>
          insertAllDayEvent(
            team.id,
            (tm as any).id as TeamMember.TeamMemberId,
            '2026-07-15T12:00:00Z',
          ),
        ),
        Effect.bind('found', ({ inserted }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
          ),
        ),
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            // The row must exist at all (an inner/`UPDATE...FROM` join would drop it).
            expect(Option.isSome(found)).toBe(true);
            const row = Option.getOrThrow(found) as any;
            // Europe/Prague fallback: noon UTC = 14:00 Prague, same calendar date.
            expect(row.start_date).toBe('2026-07-15');
            expect(row.start_date).toMatch(DATE_ONLY_RE);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Winter fixture — the fallback zone's own DST does not move the date either.
  it.effect(
    'team with no team_settings row, winter date → still Europe/Prague fallback, same UTC date',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('310000000000000004', 'owner-4')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('311010101010101014' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('inserted', ({ team, tm }) =>
          insertAllDayEvent(
            team.id,
            (tm as any).id as TeamMember.TeamMemberId,
            '2026-01-15T12:00:00Z',
          ),
        ),
        Effect.bind('found', ({ inserted }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
          ),
        ),
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            const row = Option.getOrThrow(found) as any;
            expect(row.start_date).toBe('2026-01-15');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // findEventsByTeamId (feeds EventApi.EventInfo — the team event list/calendar)
  // must carry the same projection, not just findEventByIdWithDetails.
  it.effect(
    'findEventsByTeamId also carries start_date/end_date (feeds EventInfo, the calendar view)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('310000000000000005', 'owner-5')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('311010101010101015' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Pacific/Auckland')),
        Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('inserted', ({ team, tm }) =>
          insertAllDayEvent(
            team.id,
            (tm as any).id as TeamMember.TeamMemberId,
            '2026-07-15T12:00:00Z',
          ),
        ),
        Effect.bind('list', ({ team }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEventsByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ list, inserted }) =>
          Effect.sync(() => {
            const row = (list as any[]).find((e) => e.id === inserted.id);
            expect(row).toBeDefined();
            // Auckland is NZST +12 in July — noon UTC is already the next local day.
            // This is the documented, accepted PR-3b non-neutral case for +12..+14
            // teams (§17): the derived date is D+1 while formatUtcDate would say D.
            expect(row.start_date).toBe('2026-07-16');
            expect(row.start_date).toMatch(DATE_ONLY_RE);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // end_date is COALESCE(end_at, start_at) — a single-day event's end_date equals
  // its start_date rather than being NULL/absent (§11.4's note on the Option shape).
  it.effect('end_date defaults to start_date when end_at is NULL (single-day all-day event)', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('310000000000000006', 'owner-6')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('311010101010101016' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        insertAllDayEvent(
          team.id,
          (tm as any).id as TeamMember.TeamMemberId,
          '2026-07-15T12:00:00Z',
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          const row = Option.getOrThrow(found) as any;
          expect(row.end_date).toBe(row.start_date);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
