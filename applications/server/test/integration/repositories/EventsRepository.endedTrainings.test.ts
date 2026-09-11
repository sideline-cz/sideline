// TDD mode — PR 4 of the all-day-Discord-start-time plan (§7.7a of the test spec,
// §14.4/§18 for the v4 "+1 local day" instant-arithmetic delta, §4.4.4 for the
// LEFT JOIN + COALESCE(timezone) requirement).
//
// `findEndedTrainings` (`EventsRepository.ts`) currently takes NO `now` parameter —
// it reads `NOW()` directly in `COALESCE(end_at, start_at) < NOW()`. This file
// requires the developer to:
//   1. parameterise it exactly as `TeamSettingsRepository` does for its three
//      reminder queries — a private `_findEndedTrainings(nowParam)` plus a public
//      `findEndedTrainingsForAutoLogAt(now: Date)` / `findEndedTrainingsForAutoLog()`
//      pair (the latter calling the former with `new Date()`), so the SQL is
//      testable without the wall clock;
//   2. splice the shared `eventVisibleAt`-shaped "+1 local day" instant fragment
//      (plan §14.1/§14.4) so an all-day training stays "not yet ended" through the
//      end of its last LOCAL day, instead of the bare `COALESCE(end_at, start_at) <
//      NOW()` comparison, which — because `start_at` is now a real team-local-midnight
//      instant (not the old noon-UTC sentinel) — would fire the auto-log the INSTANT
//      the event starts. That is the exact regression case 3 pins.
//
// Every test below is expected to FAIL until both are implemented. Uses `TestPgClient`
// (testcontainers, real Postgres) — the query is raw SQL with `AT TIME ZONE` /
// `INTERVAL` arithmetic that a mock cannot exercise.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  TeamSettingsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
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
        eventHorizonDays: 30,
        minPlayersThreshold: 5,
        timezone,
      }),
    ),
  );

const seedTeamWithMember = (
  discordId: string,
  username: string,
  guildId: Discord.Snowflake,
  timezone?: string,
) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.tap(({ team }) =>
      timezone !== undefined ? setTeamTimezone(team.id, timezone) : Effect.void,
    ),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, memberId: (member as any).id as string })),
  );

const insertTraining = (
  teamId: Team.TeamId,
  createdBy: string,
  allDay: boolean,
  startAtIso: string,
  endAtIso?: string,
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: allDay ? 'All-day training' : 'Timed training',
        description: Option.none(),
        startAt: DateTime.makeUnsafe(startAtIso),
        endAt: endAtIso === undefined ? Option.none() : Option.some(DateTime.makeUnsafe(endAtIso)),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy: createdBy as any,
        allDay,
      }),
    ),
  );

const setStatus = (eventId: string, status: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET status = '${status}' WHERE id = '${eventId}'`),
    ),
  );

const setAutoLogged = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET auto_logged_at = now() WHERE id = '${eventId}'`),
    ),
  );

/** Calls the (not-yet-existing) `now`-parameterised finder. TDD: implement
 * `EventsRepository#findEndedTrainingsForAutoLogAt(now: Date)`. */
const findEndedAt = (now: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen(
      (repo) =>
        (repo as any).findEndedTrainingsForAutoLogAt(new Date(now)) as Effect.Effect<
          ReadonlyArray<{ id: string }>,
          unknown,
          never
        >,
    ),
  );

describe('EventsRepository — findEndedTrainingsForAutoLogAt (PR 4, all-day defers to end of last local day)', () => {
  it.effect('case 1: timed, end_at 10:00Z, now 10:01Z → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000001',
          'ended-1',
          '440010000000000001' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertTraining(
          seed.team.id,
          seed.memberId,
          false,
          '2026-07-15T08:00:00Z',
          '2026-07-15T10:00:00Z',
        ),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.bind('rows', () => findEndedAt('2026-07-15T10:01:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 2: timed, end_at 10:00Z, now 09:59Z → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000002',
          'ended-2',
          '440010000000000002' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertTraining(
          seed.team.id,
          seed.memberId,
          false,
          '2026-07-15T08:00:00Z',
          '2026-07-15T10:00:00Z',
        ),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.bind('rows', () => findEndedAt('2026-07-15T09:59:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).not.toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 3: all-day (Prague CEST), start_at = local midnight, now = local midnight (the exact regression) → NOT returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '440000000000000003',
            'ended-3',
            '440010000000000003' as Discord.Snowflake,
            'Europe/Prague',
          ),
        ),
        // 2026-07-15T00:00 CEST (+2) = 2026-07-14T22:00:00Z
        Effect.bind('event', ({ seed }) =>
          insertTraining(seed.team.id, seed.memberId, true, '2026-07-14T22:00:00Z'),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('rows', () => findEndedAt('2026-07-14T22:00:00Z')),
        Effect.tap(({ rows, event }) =>
          Effect.sync(() => {
            expect(rows.map((r) => r.id)).not.toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 4: all-day Prague, now = 23:00 local same day → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000004',
          'ended-4',
          '440010000000000004' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertTraining(seed.team.id, seed.memberId, true, '2026-07-14T22:00:00Z'),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      // 2026-07-15T23:00 CEST = 2026-07-15T21:00:00Z
      Effect.bind('rows', () => findEndedAt('2026-07-15T21:00:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).not.toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 5: all-day Prague, now = 00:01 local NEXT day → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000005',
          'ended-5',
          '440010000000000005' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertTraining(seed.team.id, seed.memberId, true, '2026-07-14T22:00:00Z'),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      // 2026-07-16T00:01 CEST = 2026-07-15T22:01:00Z
      Effect.bind('rows', () => findEndedAt('2026-07-15T22:01:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 6: all-day winter (Prague CET), now = 23:59 local same day → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000006',
          'ended-6',
          '440010000000000006' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      // 2026-01-15T00:00 CET (+1) = 2026-01-14T23:00:00Z
      Effect.bind('event', ({ seed }) =>
        insertTraining(seed.team.id, seed.memberId, true, '2026-01-14T23:00:00Z'),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      // 2026-01-15T23:59 CET = 2026-01-15T22:59:00Z
      Effect.bind('rows', () => findEndedAt('2026-01-15T22:59:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).not.toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 7: all-day winter (Prague CET), now = 00:01 local next day → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000007',
          'ended-7',
          '440010000000000007' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertTraining(seed.team.id, seed.memberId, true, '2026-01-14T23:00:00Z'),
      ),
      // 2026-01-16T00:01 CET = 2026-01-15T23:01:00Z
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.bind('rows', () => findEndedAt('2026-01-15T23:01:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 8: all-day, well before its date → NOT returned (a malformed predicate returning everything would pass cases 3-7 but not this one)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '440000000000000008',
            'ended-8',
            '440010000000000008' as Discord.Snowflake,
            'Europe/Prague',
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          insertTraining(seed.team.id, seed.memberId, true, '2026-07-14T22:00:00Z'),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('rows', () => findEndedAt('2026-07-10T12:00:00Z')),
        Effect.tap(({ rows, event }) =>
          Effect.sync(() => {
            expect(rows.map((r) => r.id)).not.toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 9: multi-day all-day 07-15 -> 07-17, now = 00:01 local day 2->3 → NOT returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '440000000000000009',
            'ended-9',
            '440010000000000009' as Discord.Snowflake,
            'Europe/Prague',
          ),
        ),
        // start 2026-07-15T00:00 CEST = 2026-07-14T22:00:00Z
        // end   2026-07-17T00:00 CEST = 2026-07-16T22:00:00Z (inclusive last day)
        Effect.bind('event', ({ seed }) =>
          insertTraining(
            seed.team.id,
            seed.memberId,
            true,
            '2026-07-14T22:00:00Z',
            '2026-07-16T22:00:00Z',
          ),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('rows', () => findEndedAt('2026-07-16T22:01:00Z')),
        Effect.tap(({ rows, event }) =>
          Effect.sync(() => {
            expect(rows.map((r) => r.id)).not.toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 10: multi-day all-day, after last local day → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000010',
          'ended-10',
          '440010000000000010' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertTraining(
          seed.team.id,
          seed.memberId,
          true,
          '2026-07-14T22:00:00Z',
          '2026-07-16T22:00:00Z',
        ),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.bind('rows', () => findEndedAt('2026-07-17T22:01:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 11: DST spring-forward, all-day 2026-03-29 → returned at 22:01Z', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000011',
          'ended-11',
          '440010000000000011' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      // 2026-03-29T00:00 CET (still +1, transition is later that day) = 2026-03-28T23:00:00Z
      Effect.bind('event', ({ seed }) =>
        insertTraining(seed.team.id, seed.memberId, true, '2026-03-28T23:00:00Z'),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.bind('rows', () => findEndedAt('2026-03-29T22:01:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 12: 7-day lower bound still holds for all-day events', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000012',
          'ended-12',
          '440010000000000012' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      // 2026-07-01T00:00 CEST = 2026-06-30T22:00:00Z — well over 7 days before `now`.
      Effect.bind('event', ({ seed }) =>
        insertTraining(seed.team.id, seed.memberId, true, '2026-06-30T22:00:00Z'),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.bind('rows', () => findEndedAt('2026-07-15T12:00:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).not.toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 13: already auto-logged → NOT returned regardless of instant', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '440000000000000013',
          'ended-13',
          '440010000000000013' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertTraining(
          seed.team.id,
          seed.memberId,
          false,
          '2026-07-15T08:00:00Z',
          '2026-07-15T10:00:00Z',
        ),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.tap(({ event }) => setAutoLogged(event.id)),
      Effect.bind('rows', () => findEndedAt('2026-07-15T10:01:00Z')),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.id)).not.toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
