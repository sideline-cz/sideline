// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require a new EventsRepository method:
//   markStalePersonalMessagesDirty(): marks events with existing
//   personal_event_messages rows dirty when the event is no longer an
//   upcoming active event (status <> 'active' OR start_at < now()), but only
//   when personal_messages_dirty_at IS NULL (does not disturb events that
//   are already dirty / mid-reconcile).
//
// These tests WILL FAIL until the developer implements
// EventsRepository#markStalePersonalMessagesDirty.
//
// PR 4 ADDITIONS (below the original suite, §7.7d of the all-day-Discord-start-
// time plan): the sweep's predicate must become the exact NEGATION of the
// shared `eventVisibleNow` visibility fragment (§4.4.4), not the bare
// `status <> 'active' OR start_at < now()` above — otherwise a `started`
// all-day event still on its own local day gets swept dirty every cron cycle,
// and the reconcile that follows deletes the personal message PR 4 decided to
// keep (an infinite create/delete loop against the Discord API, per the
// plan's task-list warning). The rewrite MUST use a correlated scalar
// subselect for the team's timezone (`COALESCE((SELECT ts.timezone FROM
// team_settings ts WHERE ts.team_id = e.team_id), 'Europe/Prague')`), NOT an
// `UPDATE events e ... FROM team_settings ts` (an INNER join, which would
// silently and permanently stop sweeping every event of a team with no
// `team_settings` row) — case 6 below pins exactly that trap with a TIMED
// event (which must keep sweeping regardless of the all-day rewrite).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { PersonalEventMessagesRepository } from '~/repositories/PersonalEventMessagesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  PersonalEventMessagesRepository.Default,
  EventsRepository.Default,
  TeamSettingsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers (mirrors PersonalEventMessagesRepository.test.ts)
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

const seedTeamWithMember = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, member })),
  );

const createEvent = (teamId: Team.TeamId, createdBy: string, startAtIso: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Test Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date(startAtIso)),
        endAt: Option.none(),
        location: Option.none(),
        trainingTypeId: Option.none(),
        createdBy: createdBy as any,
      }),
    ),
  );

const addPersonalEventMessageRow = (eventId: string, teamMemberId: string, seq: number) =>
  PersonalEventMessagesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertPersonalEventMessage(
        eventId as any,
        teamMemberId as any,
        `43000000000000${String(seq).padStart(4, '0')}` as Discord.Snowflake,
        `43100000000000${String(seq).padStart(4, '0')}` as Discord.Snowflake,
        `hash-${String(seq)}`,
      ),
    ),
  );

const setEventStatus = (eventId: string, status: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET status = '${status}' WHERE id = '${eventId}'`),
    ),
  );

const setEventStartAt = (eventId: string, startAtIso: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET start_at = '${startAtIso}' WHERE id = '${eventId}'`),
    ),
  );

// Sets start_at relative to the DB's own clock (e.g. "1 day", "10 years") so the
// test never inverts as wall-clock time passes a hardcoded literal date.
const setEventStartAtRelative = (eventId: string, interval: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(
        `UPDATE events SET start_at = now() + interval '${interval}' WHERE id = '${eventId}'`,
      ),
    ),
  );

const setDirtyAt = (eventId: string, iso: string | null) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(
        iso === null
          ? `UPDATE events SET personal_messages_dirty_at = NULL WHERE id = '${eventId}'`
          : `UPDATE events SET personal_messages_dirty_at = '${iso}' WHERE id = '${eventId}'`,
      ),
    ),
  );

// Cast to ::text so we get a stable, directly-comparable string instead of a
// postgres.js Date object (two SELECTs of the same instant otherwise produce
// distinct Date instances that fail Object.is / toBe comparisons).
const getDirtyAt = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ dirty_at: string | null }>(
        `SELECT personal_messages_dirty_at::text AS dirty_at FROM events WHERE id = '${eventId}'`,
      ),
    ),
    Effect.map((rows) => rows[0]?.dirty_at ?? null),
  );

const runSweep = (): Effect.Effect<void, unknown, EventsRepository> =>
  EventsRepository.asEffect().pipe(
    Effect.andThen(
      (repo) =>
        // TDD: implement EventsRepository#markStalePersonalMessagesDirty
        (repo as any).markStalePersonalMessagesDirty() as Effect.Effect<void, unknown, never>,
    ),
  );

describe('EventsRepository — markStalePersonalMessagesDirty', () => {
  it.effect(
    'started event WITH a personal_event_messages row and NULL dirty_at is marked dirty',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '430000000000000001',
            'stale-started-1',
            '430010101010101010' as Discord.Snowflake,
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.member.id, '2027-06-01T14:00:00Z'),
        ),
        Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 1)),
        Effect.tap(({ event }) => setEventStatus(event.id, 'started')),
        Effect.tap(() => runSweep()),
        Effect.bind('dirtyAt', ({ event }) => getDirtyAt(event.id)),
        Effect.tap(({ dirtyAt }) =>
          Effect.sync(() => {
            expect(dirtyAt).not.toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('active event with start_at in the past WITH a row is marked dirty', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '430000000000000002',
          'stale-past-active-1',
          '430020202020202020' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        // Inserted with a future start_at, then rewound to the past below —
        // insertEvent enforces no particular constraint on start_at.
        createEvent(seed.team.id, seed.member.id, '2027-06-02T14:00:00Z'),
      ),
      Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 2)),
      Effect.tap(({ event }) => setEventStartAt(event.id, '2020-01-01T00:00:00Z')),
      Effect.tap(() => runSweep()),
      Effect.bind('dirtyAt', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(({ dirtyAt }) =>
        Effect.sync(() => {
          expect(dirtyAt).not.toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('active future event WITH a row is NOT marked dirty', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '430000000000000003',
          'stale-future-active-1',
          '430030303030303030' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        // Inserted with some start_at, then pinned relative to the DB clock below.
        createEvent(seed.team.id, seed.member.id, '2027-06-03T14:00:00Z'),
      ),
      Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 3)),
      // status stays 'active' (default); start_at is always 1 day ahead of "now"
      // from the DB's own clock, so this never inverts as wall-clock time passes.
      Effect.tap(({ event }) => setEventStartAtRelative(event.id, '1 day')),
      Effect.tap(() => runSweep()),
      Effect.bind('dirtyAt', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(({ dirtyAt }) =>
        Effect.sync(() => {
          expect(dirtyAt).toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('started event WITHOUT any personal_event_messages rows is NOT marked dirty', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '430000000000000004',
          'stale-no-rows-1',
          '430040404040404040' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.member.id, '2027-06-04T14:00:00Z'),
      ),
      Effect.tap(({ event }) => setEventStatus(event.id, 'started')),
      // No personal_event_messages row for this event.
      Effect.tap(() => runSweep()),
      Effect.bind('dirtyAt', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(({ dirtyAt }) =>
        Effect.sync(() => {
          expect(dirtyAt).toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('started event WITH a row but already dirty is left unchanged (IS NULL guard)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '430000000000000005',
          'stale-already-dirty-1',
          '430050505050505050' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.member.id, '2027-06-05T14:00:00Z'),
      ),
      Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 5)),
      Effect.tap(({ event }) => setEventStatus(event.id, 'started')),
      // Pre-set an existing dirty_at marker (simulating an in-flight reconcile).
      Effect.tap(({ event }) => setDirtyAt(event.id, '2025-01-01T00:00:00.000Z')),
      Effect.bind('dirtyAtBefore', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(() => runSweep()),
      Effect.bind('dirtyAtAfter', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(({ dirtyAtBefore, dirtyAtAfter }) =>
        Effect.sync(() => {
          expect(dirtyAtBefore).not.toBeNull();
          expect(dirtyAtAfter).toBe(dirtyAtBefore);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// PR 4 additions — plan §7.7d. The sweep predicate becomes the exact negation
// of `eventVisibleNow` (§4.4.4): a `started` all-day event still on its own
// local day must NOT be swept dirty (that would delete the personal message
// PR 4 decided to keep), but once its last local day has passed it must be
// swept exactly like any other stale event.
// ---------------------------------------------------------------------------

const setAllDay = (eventId: string, allDay: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(
        `UPDATE events SET all_day = ${allDay ? 'TRUE' : 'FALSE'} WHERE id = '${eventId}'`,
      ),
    ),
  );

const setTeamTimezone = (teamId: string, timezone: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId: teamId as any,
        eventHorizonDays: 30,
        minPlayersThreshold: 5,
        timezone,
      }),
    ),
  );

/** Team-local midnight of (today + dayOffset), asked of Postgres itself, so
 * this suite stays correct no matter when it runs. */
const localMidnight = (tz: string, dayOffset: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ instant: Date }>(
        `SELECT (((now() AT TIME ZONE '${tz}')::date + ${dayOffset}) AT TIME ZONE '${tz}') AS instant`,
      ),
    ),
    Effect.map((rows) => rows[0]?.instant.toISOString()),
  );

describe('EventsRepository — markStalePersonalMessagesDirty: all-day stays live through its last local day (PR 4)', () => {
  it.effect(
    'case 1: all-day, status=started, still its own local day, WITH a row → NOT marked dirty (fails today; the exact regression)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '431000000000000001',
            'pr4-stale-1',
            '431010101010101010' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => setTeamTimezone(seed.team.id, 'Europe/Prague')),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ seed, start }) => createEvent(seed.team.id, seed.member.id, start)),
        Effect.tap(({ event }) => setAllDay(event.id, true)),
        Effect.tap(({ event }) => setEventStatus(event.id, 'started')),
        Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 101)),
        Effect.tap(() => runSweep()),
        Effect.bind('dirtyAt', ({ event }) => getDirtyAt(event.id)),
        Effect.tap(({ dirtyAt }) =>
          Effect.sync(() => {
            expect(dirtyAt).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 2: all-day, status=started, local day PASSED, WITH a row → marked dirty', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '431000000000000002',
          'pr4-stale-2',
          '431010101010101011' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => setTeamTimezone(seed.team.id, 'Europe/Prague')),
      Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
      Effect.bind('event', ({ seed, start }) => createEvent(seed.team.id, seed.member.id, start)),
      Effect.tap(({ event }) => setAllDay(event.id, true)),
      Effect.tap(({ event }) => setEventStatus(event.id, 'started')),
      Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 102)),
      Effect.tap(() => runSweep()),
      Effect.bind('dirtyAt', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(({ dirtyAt }) =>
        Effect.sync(() => {
          expect(dirtyAt).not.toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 5: idempotence — running the sweep twice marks nothing new the second time', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '431000000000000005',
          'pr4-stale-5',
          '431010101010101012' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => setTeamTimezone(seed.team.id, 'Europe/Prague')),
      Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
      Effect.bind('event', ({ seed, start }) => createEvent(seed.team.id, seed.member.id, start)),
      Effect.tap(({ event }) => setAllDay(event.id, true)),
      Effect.tap(({ event }) => setEventStatus(event.id, 'started')),
      Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 105)),
      Effect.tap(() => runSweep()),
      Effect.bind('dirtyAtFirst', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(() => runSweep()),
      Effect.bind('dirtyAtSecond', ({ event }) => getDirtyAt(event.id)),
      Effect.tap(({ dirtyAtFirst, dirtyAtSecond }) =>
        Effect.sync(() => {
          expect(dirtyAtFirst).not.toBeNull();
          // The IS NULL guard means the second run is a no-op for this row —
          // the timestamp must be unchanged, not bumped to a later `now()`.
          expect(dirtyAtSecond).toBe(dirtyAtFirst);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 6: NO team_settings row for the team — a TIMED started event WITH a row is STILL marked dirty (catches the INNER-join rewrite trap)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          // Deliberately no setTeamTimezone call — no team_settings row exists.
          seedTeamWithMember(
            '431000000000000006',
            'pr4-stale-6',
            '431010101010101013' as Discord.Snowflake,
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.member.id, '2020-01-01T00:00:00Z'),
        ),
        Effect.tap(({ event }) => setEventStatus(event.id, 'started')),
        Effect.tap(({ event, seed }) => addPersonalEventMessageRow(event.id, seed.member.id, 106)),
        Effect.tap(() => runSweep()),
        Effect.bind('dirtyAt', ({ event }) => getDirtyAt(event.id)),
        Effect.tap(({ dirtyAt }) =>
          Effect.sync(() => {
            expect(dirtyAt).not.toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 7: NO team_settings row, all-day started — Europe/Prague FALLBACK is actually applied (local day passed → dirty; still today → not dirty)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seedPassed', () =>
          seedTeamWithMember(
            '431000000000000007',
            'pr4-stale-7a',
            '431010101010101014' as Discord.Snowflake,
          ),
        ),
        Effect.bind('startPassed', () => localMidnight('Europe/Prague', -2)),
        Effect.bind('eventPassed', ({ seedPassed, startPassed }) =>
          createEvent(seedPassed.team.id, seedPassed.member.id, startPassed),
        ),
        Effect.tap(({ eventPassed }) => setAllDay(eventPassed.id, true)),
        Effect.tap(({ eventPassed }) => setEventStatus(eventPassed.id, 'started')),
        Effect.tap(({ eventPassed, seedPassed }) =>
          addPersonalEventMessageRow(eventPassed.id, seedPassed.member.id, 107),
        ),
        Effect.bind('seedToday', () =>
          seedTeamWithMember(
            '431000000000000008',
            'pr4-stale-7b',
            '431010101010101015' as Discord.Snowflake,
          ),
        ),
        Effect.bind('startToday', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('eventToday', ({ seedToday, startToday }) =>
          createEvent(seedToday.team.id, seedToday.member.id, startToday),
        ),
        Effect.tap(({ eventToday }) => setAllDay(eventToday.id, true)),
        Effect.tap(({ eventToday }) => setEventStatus(eventToday.id, 'started')),
        Effect.tap(({ eventToday, seedToday }) =>
          addPersonalEventMessageRow(eventToday.id, seedToday.member.id, 108),
        ),
        Effect.tap(() => runSweep()),
        Effect.bind('dirtyPassed', ({ eventPassed }) => getDirtyAt(eventPassed.id)),
        Effect.bind('dirtyToday', ({ eventToday }) => getDirtyAt(eventToday.id)),
        Effect.tap(({ dirtyPassed, dirtyToday }) =>
          Effect.sync(() => {
            expect(dirtyPassed).not.toBeNull();
            expect(dirtyToday).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
