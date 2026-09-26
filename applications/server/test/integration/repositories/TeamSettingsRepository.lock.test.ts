// T5 — the RSVP-lock resolution fragment, against real Postgres.
//
// WRITTEN IN TDD MODE, BEFORE THE IMPLEMENTATION. It requires:
//   - migration `1793300000_rsvp_lock_hours_before` (team_settings.rsvp_lock_hours_before INT NULL
//     with a 0..336 CHECK, and rsvp_lock_hours_before_overrides JSONB NOT NULL DEFAULT '{}');
//   - `TeamSettingsRepository.upsert` accepting `rsvpLockHoursBefore` / `rsvpLockHoursBeforeOverrides`;
//   - `repositories/lockResolution.ts#resolvedLockHours` spliced into both `EventsRepository`
//     queries as `rsvp_lock_hours_before`.
//
// What it is actually testing is one SQL expression and its four behaviours:
//   key absent            → the team-wide value
//   key present, JSON null → NULL (off for this type)  ← the §1d escape hatch
//   key present, a number  → that number, INCLUDING 0
//   key present, garbage   → NULL (off), and the query must not raise. A
//                            FRACTIONAL number is 'number' to `jsonb_typeof`
//                            too, and is floored rather than refused; an
//                            OUT-OF-RANGE one is off, like any other garbage
//
// The integration suite is SERIAL — overlapping local runs deadlock and mimic
// real failures. Run this file on its own.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, Team, TeamSettings, User } from '@sideline/domain';
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
  TeamSettingsRepository.Default,
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// --- helpers (same shape as TeamSettingsRepository.reminder.test.ts) ---------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
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
        name: 'Lock Team',
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

const seedTeamWithMember = (n: string) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(`3000000000000${n}`, `lockowner${n}`)),
    Effect.bind('team', ({ userId }) => createTeam(`${n}${n}${n}` as Discord.Snowflake, userId)),
    Effect.bind('member', ({ team, userId }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.addMember({
            team_id: team.id,
            user_id: userId,
            active: true,
            joined_at: undefined,
          }),
        ),
      ),
    ),
    Effect.map(({ team, member }) => ({ team, memberId: member.id })),
  );

const upsertLockSettings = (
  teamId: Team.TeamId,
  lock: Option.Option<number>,
  overrides: TeamSettings.RsvpLockHoursBeforeOverrides = {},
) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 5,
        rsvpLockHoursBefore: lock,
        rsvpLockHoursBeforeOverrides: overrides,
      }),
    ),
  );

const createEvent = (
  teamId: Team.TeamId,
  createdBy: string,
  eventType: 'training' | 'match' | 'tournament' | 'meeting' | 'social' | 'other' = 'training',
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType,
        title: `Lockable ${eventType}`,
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2029-06-03T12:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy: createdBy as never,
      }),
    ),
  );

/** The resolved lock as `findByIdWithDetails` sees it. */
const resolvedLockFor = (eventId: Event.EventId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEventByIdWithDetails(eventId)),
    Effect.map((found) =>
      Option.match(found, {
        onNone: () => Option.none<number>(),
        onSome: (e) => e.rsvp_lock_hours_before,
      }),
    ),
  );

const writeOverridesDirectly = (teamId: Team.TeamId, json: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql`UPDATE team_settings SET rsvp_lock_hours_before_overrides = ${json}::jsonb WHERE team_id = ${teamId}`,
    ),
  );

// ---------------------------------------------------------------------------

describe('resolvedLockHours — team-wide value and per-type overrides', () => {
  it.effect('case 1: a team with no team_settings row at all resolves to NULL (no lock)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0301')),
      Effect.bind('event', ({ seed }) => createEvent(seed.team.id, seed.memberId)),
      Effect.bind('lock', ({ event }) => resolvedLockFor(event.id)),
      Effect.tap(({ lock }) => Effect.sync(() => expect(Option.isNone(lock)).toBe(true))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 2: the team-wide value applies to a type with no override', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0302')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.some(24))),
      Effect.bind('event', ({ seed }) => createEvent(seed.team.id, seed.memberId, 'training')),
      Effect.bind('lock', ({ event }) => resolvedLockFor(event.id)),
      Effect.tap(({ lock }) => Effect.sync(() => expect(Option.getOrNull(lock)).toBe(24))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 3: an override of ZERO wins over the base — not 24, not NULL', () =>
    // The case a naive `COALESCE(NULLIF(override, 0), base)` gets wrong.
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0303')),
      Effect.tap(({ seed }) =>
        upsertLockSettings(seed.team.id, Option.some(24), { tournament: 0 }),
      ),
      Effect.bind('event', ({ seed }) => createEvent(seed.team.id, seed.memberId, 'tournament')),
      Effect.bind('lock', ({ event }) => resolvedLockFor(event.id)),
      Effect.tap(({ lock }) => Effect.sync(() => expect(Option.getOrNull(lock)).toBe(0))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 4: a type absent from the map inherits the base', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0304')),
      Effect.tap(({ seed }) =>
        upsertLockSettings(seed.team.id, Option.some(24), { tournament: 0 }),
      ),
      Effect.bind('event', ({ seed }) => createEvent(seed.team.id, seed.memberId, 'training')),
      Effect.bind('lock', ({ event }) => resolvedLockFor(event.id)),
      Effect.tap(({ lock }) => Effect.sync(() => expect(Option.getOrNull(lock)).toBe(24))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 5: a base of NULL still honours a per-type override, and leaves others off', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0305')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.none(), { match: 12 })),
      Effect.bind('matchEvent', ({ seed }) => createEvent(seed.team.id, seed.memberId, 'match')),
      Effect.bind('trainingEvent', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, 'training'),
      ),
      Effect.bind('matchLock', ({ matchEvent }) => resolvedLockFor(matchEvent.id)),
      Effect.bind('trainingLock', ({ trainingEvent }) => resolvedLockFor(trainingEvent.id)),
      Effect.tap(({ matchLock, trainingLock }) =>
        Effect.sync(() => {
          expect(Option.getOrNull(matchLock)).toBe(12);
          expect(Option.isNone(trainingLock)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 6: an explicit per-type NULL turns the lock OFF for that type only', () =>
    // §1d mitigation 2 — the only way to keep the all-day end-of-day grace for
    // tournaments while the rest of the team locks 24h out.
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0306')),
      Effect.tap(({ seed }) =>
        upsertLockSettings(seed.team.id, Option.some(24), { tournament: null }),
      ),
      Effect.bind('tournament', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, 'tournament'),
      ),
      Effect.bind('training', ({ seed }) => createEvent(seed.team.id, seed.memberId, 'training')),
      Effect.bind('tournamentLock', ({ tournament }) => resolvedLockFor(tournament.id)),
      Effect.bind('trainingLock', ({ training }) => resolvedLockFor(training.id)),
      Effect.tap(({ tournamentLock, trainingLock }) =>
        Effect.sync(() => {
          expect(Option.isNone(tournamentLock)).toBe(true);
          expect(Option.getOrNull(trainingLock)).toBe(24);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('resolvedLockHours — hostile values written by direct SQL', () => {
  it.effect('case 7: an unknown event-type key is ignored and the base still applies', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0307')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.some(24))),
      Effect.tap(({ seed }) => writeOverridesDirectly(seed.team.id, '{"not_a_type":4}')),
      Effect.bind('event', ({ seed }) => createEvent(seed.team.id, seed.memberId, 'training')),
      Effect.bind('lock', ({ event }) => resolvedLockFor(event.id)),
      Effect.tap(({ lock }) => Effect.sync(() => expect(Option.getOrNull(lock)).toBe(24))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 8: a NON-NUMERIC override degrades to OFF and does not raise', () =>
    // Direction differs from the reminder precedent on purpose: there, garbage
    // falls back to the base (keep reminders firing); here it degrades to off,
    // because wrongly REFUSING an RSVP is the worse failure. The `::int` cast
    // must never see it — this query spans a whole team's event list.
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0308')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.some(24))),
      Effect.tap(({ seed }) => writeOverridesDirectly(seed.team.id, '{"training":"soon"}')),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, 'training')),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, 'match')),
      Effect.bind('list', ({ seed }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventsByTeamId(seed.team.id)),
        ),
      ),
      Effect.tap(({ list }) =>
        Effect.sync(() => {
          // The blast-radius guard: the whole list still comes back.
          expect(list.length).toBe(2);
          const byType = new Map(list.map((e) => [e.event_type, e.rsvp_lock_hours_before]));
          expect(Option.isNone(byType.get('training') ?? Option.some(-1))).toBe(true);
          expect(Option.getOrNull(byType.get('match') ?? Option.none())).toBe(24);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 8b: a FRACTIONAL override is FLOORED and does not raise', () =>
    // `jsonb_typeof('1.5'::jsonb)` is 'number', so the type gate alone lets it
    // through to the cast — and `SELECT '1.5'::int` RAISES. Without
    // `FLOOR(…::numeric)` in `resolvedLockHours`, one such value takes down
    // every query that splices the fragment for that team. It floors rather
    // than degrading to off because that is the permissive direction: 1.5 h
    // becomes a 1 h lock, not a 2 h one.
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0313')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.some(24))),
      Effect.tap(({ seed }) => writeOverridesDirectly(seed.team.id, '{"training":1.5}')),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, 'training')),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, 'match')),
      Effect.bind('list', ({ seed }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventsByTeamId(seed.team.id)),
        ),
      ),
      Effect.tap(({ list }) =>
        Effect.sync(() => {
          // The blast-radius guard: the whole list still comes back.
          expect(list.length).toBe(2);
          const byType = new Map(list.map((e) => [e.event_type, e.rsvp_lock_hours_before]));
          expect(Option.getOrNull(byType.get('training') ?? Option.none())).toBe(1);
          expect(Option.getOrNull(byType.get('match') ?? Option.none())).toBe(24);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 8c: an OUT-OF-RANGE override degrades to OFF and does not raise', () =>
    // Same class as 8b, other end: `1e20` is a valid jsonb number that no `int`
    // can hold, so the cast raises with "integer out of range" instead of
    // "invalid input syntax". The `BETWEEN 0 AND 336` test is what covers both.
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0314')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.some(24))),
      Effect.tap(({ seed }) => writeOverridesDirectly(seed.team.id, '{"training":1e20}')),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, 'training')),
      Effect.bind('list', ({ seed }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventsByTeamId(seed.team.id)),
        ),
      ),
      Effect.tap(({ list }) =>
        Effect.sync(() => {
          expect(list.length).toBe(1);
          expect(Option.isNone(list[0]?.rsvp_lock_hours_before ?? Option.some(-1))).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('TeamSettingsRepository — lock round-trip', () => {
  it.effect('case 9: upsert → findByTeamId returns the same scalar and map, nulls intact', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0309')),
      Effect.tap(({ seed }) =>
        upsertLockSettings(seed.team.id, Option.some(24), { tournament: null, training: 0 }),
      ),
      Effect.bind('settings', ({ seed }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(seed.team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          const s = Option.getOrThrow(settings);
          expect(Option.getOrNull(s.rsvp_lock_hours_before)).toBe(24);
          expect('tournament' in s.rsvp_lock_hours_before_overrides).toBe(true);
          expect(s.rsvp_lock_hours_before_overrides.tournament).toBeNull();
          expect(s.rsvp_lock_hours_before_overrides.training).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 9b: Option.none() round-trips as NULL, never as 0', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0310')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.none())),
      Effect.bind('settings', ({ seed }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(seed.team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          const s = Option.getOrThrow(settings);
          expect(Option.isNone(s.rsvp_lock_hours_before)).toBe(true);
          expect(s.rsvp_lock_hours_before_overrides).toStrictEqual({});
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 10: findByIdWithDetails and findByTeamId agree on the same event', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0311')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.some(24), { match: 3 })),
      Effect.bind('event', ({ seed }) => createEvent(seed.team.id, seed.memberId, 'match')),
      Effect.bind('single', ({ event }) => resolvedLockFor(event.id)),
      Effect.bind('list', ({ seed }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventsByTeamId(seed.team.id)),
        ),
      ),
      Effect.tap(({ single, list }) =>
        Effect.sync(() => {
          const fromList = list[0]?.rsvp_lock_hours_before ?? Option.none();
          expect(Option.getOrNull(single)).toBe(3);
          expect(Option.getOrNull(fromList)).toBe(Option.getOrNull(single));
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('team_settings.rsvp_lock_hours_before CHECK constraint', () => {
  it.effect('case 11: a direct UPDATE to 400 is rejected; NULL is accepted', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('0312')),
      Effect.tap(({ seed }) => upsertLockSettings(seed.team.id, Option.some(24))),
      Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
      Effect.bind('rejected', ({ seed, sql }) =>
        sql`UPDATE team_settings SET rsvp_lock_hours_before = 400 WHERE team_id = ${seed.team.id}`.pipe(
          Effect.as('accepted' as const),
          Effect.catchCause(() => Effect.succeed('rejected' as const)),
        ),
      ),
      Effect.tap(({ rejected }) => Effect.sync(() => expect(rejected).toBe('rejected'))),
      Effect.bind('accepted', ({ seed, sql }) =>
        sql`UPDATE team_settings SET rsvp_lock_hours_before = NULL WHERE team_id = ${seed.team.id}`.pipe(
          Effect.as('accepted' as const),
          Effect.catchCause(() => Effect.succeed('rejected' as const)),
        ),
      ),
      Effect.tap(({ accepted }) => Effect.sync(() => expect(accepted).toBe('accepted'))),
      Effect.provide(TestLayer),
    ),
  );
});
