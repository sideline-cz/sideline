// TDD mode — PR 4 of the all-day-Discord-start-time plan (§7.7b of the test spec,
// §4.3/§14.3/§14.4 for the relaxed status + "+1 local day" instant predicate).
//
// This is a SEPARATE file from `TeamSettingsRepository.reminder.test.ts` (singular —
// the pre-existing timed-event reminder-window suite, left untouched). This file
// pins the BL2 trap called out by the plan: a fixture that does not pin `status`
// explicitly goes green while production stays broken, because a real all-day
// event is `status = 'started'` (flipped at team-local midnight) well before its
// 18:00-local reminder window opens — today's `WHERE e.status = 'active'` silently
// excludes it. Every all-day fixture below pins `status` explicitly, with both
// `active` and `started` controls.
//
// All three reminder-scheduling queries (`_findEventsForReminderAt`,
// `_findEventsForClaimRequestAt`, `_findEventsForCoachingStatusAt`) must relax
// BOTH halves together — the status gate AND the instant comparison — or
// relaxing only one changes nothing (BL2). Expected to FAIL until the developer
// implements the shared `eventVisibleAt`-shaped fragment in all three.
//
// VERIFIED AGAINST REAL POSTGRES (see the tester's run): under the v4
// team-local-midnight storage anchor, the "3b" `status='active'` controls
// below are ALSO red today, not just "3" (`status='started'`) — an all-day
// event's `start_at` is local midnight, which is always in the past by the
// time any same-day reminder window opens, so the UNMODIFIED
// `e.start_at > now` half rejects it regardless of status. Only "3c" (the
// TIMED, `status='started'` defensive control) is green today, confirming the
// relaxation must stay all-day-only. This is expected and correct — it means
// BOTH halves need the fix for every all-day fixture, not just the
// `status='started'` ones; it does not indicate a broken test.
//
// Fixture instants are pre-computed against Europe/Prague (CEST +2 in July,
// CET +1 in January) — see the header comment in
// `EventsRepository.endedTrainings.test.ts` for the same derivation approach.

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
  TeamSettingsRepository.Default,
  EventsRepository.Default,
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

const seedTeamWithMember = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, memberId: member.id })),
  );

const upsertSettings = (
  teamId: Team.TeamId,
  opts: {
    daysBefore?: number;
    time?: string;
    timezone?: string;
    enabled?: boolean;
    claimRequestDaysBefore?: number;
  } = {},
) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 5,
        rsvpRemindersEnabled: opts.enabled ?? true,
        rsvpReminderDaysBefore: opts.daysBefore ?? 0,
        rsvpReminderTime: opts.time ?? '18:00',
        timezone: opts.timezone ?? 'Europe/Prague',
        claimRequestDaysBefore: opts.claimRequestDaysBefore ?? 3,
      }),
    ),
  );

const createEvent = (
  teamId: Team.TeamId,
  createdBy: string,
  startAtIso: string,
  allDay: boolean,
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

const setClaimedBy = (eventId: string, memberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET claimed_by = '${memberId}' WHERE id = '${eventId}'`),
    ),
  );

const findReminderAt = (now: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEventsNeedingReminderAt(new Date(now))),
  );

const findClaimRequestAt = (now: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEventsNeedingClaimRequestAt(new Date(now))),
  );

const findCoachingStatusAt = (now: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEventsNeedingCoachingStatusAt(new Date(now))),
  );

// ---------------------------------------------------------------------------
// _findEventsForReminderAt
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — findEventsNeedingReminderAt: all-day defers to team-local day, status relaxed', () => {
  it.effect(
    'case 3: all-day, status=started, days_before=0 → returned (fails today on both halves)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '450000000000000003',
            'reminder-3',
            '450010000000000003' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 0, time: '18:00' })),
        // 2026-07-15T00:00 CEST = 2026-07-14T22:00:00Z
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        // now = 18:00 CEST same day = 2026-07-15T16:00:00Z
        Effect.bind('events', () => findReminderAt('2026-07-15T16:00:00Z')),
        Effect.tap(({ events, event }) =>
          Effect.sync(() => {
            expect(events.map((e) => e.event_id)).toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 3b (control): all-day, status=active, same setup → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000004',
          'reminder-3b',
          '450010000000000004' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 0, time: '18:00' })),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      // status stays 'active' (default) — deliberately not flipped.
      Effect.bind('events', () => findReminderAt('2026-07-15T16:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 3c (control): TIMED event, status=started (defensive) → NOT returned — relaxation must be all-day-only',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '450000000000000005',
            'reminder-3c',
            '450010000000000005' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 0, time: '18:00' })),
        // Future start_at, but forced to 'started' — an artificial defensive fixture;
        // a real timed event never reaches 'started' before its own start_at.
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.memberId, '2026-07-15T16:00:05Z', false),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('events', () => findReminderAt('2026-07-15T16:00:00Z')),
        Effect.tap(({ events, event }) =>
          Effect.sync(() => {
            expect(events.map((e) => e.event_id)).not.toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 4: all-day, status=active, days_before=1 → returned (unchanged)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000006',
          'reminder-4',
          '450010000000000006' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 1, time: '18:00' })),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      // 18:00 CEST the day before = 2026-07-14T16:00:00Z
      Effect.bind('events', () => findReminderAt('2026-07-14T16:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 5: all-day, status=started, days_before=0, now = 18:00 local the day AFTER → NOT returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '450000000000000007',
            'reminder-5',
            '450010000000000007' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 0, time: '18:00' })),
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        // 18:00 CEST the day after = 2026-07-16T16:00:00Z
        Effect.bind('events', () => findReminderAt('2026-07-16T16:00:00Z')),
        Effect.tap(({ events, event }) =>
          Effect.sync(() => {
            expect(events.map((e) => e.event_id)).not.toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // NOTE on this case's label: the plan's §7.7b table describes it as "all-day
  // multi-day, status='started', days_before=0 | 18:00 local on day 2 of 3 |
  // returned". The reminder query's DATE-match clause is anchored to
  // `DATE(e.start_at AT TIME ZONE tz)` — the event's START date only — and the
  // plan itself says that clause is UNCHANGED by PR 4 (§4.3: "already correct...
  // leave them alone"). A literal "day 2 of 3" reading is therefore
  // unreachable under the query's own (intentionally unchanged) semantics — it
  // would require matching against every day in the event's span, which no
  // part of this plan asks for. Reinterpreted as "day 1 of 3" (the day the
  // multi-day event itself starts, by which point it has already flipped to
  // `started` at local midnight) to keep the fixture consistent with the SQL
  // this PR ships, while preserving the case's actual intent: a multi-day
  // all-day event, already `started`, still returns its one-time reminder.
  it.effect(
    'case 6 (reinterpreted, see note above): all-day multi-day, status=started, days_before=0, 18:00 local on day 1 of 3 → returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '450000000000000008',
            'reminder-6',
            '450010000000000008' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 0, time: '18:00' })),
        // 07-15 -> 07-17 inclusive (Prague CEST)
        Effect.bind('event', ({ seed }) =>
          createEvent(
            seed.team.id,
            seed.memberId,
            '2026-07-14T22:00:00Z',
            true,
            '2026-07-16T22:00:00Z',
          ),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        // 18:00 CEST on day 1 (07-15) = 2026-07-15T16:00:00Z
        Effect.bind('events', () => findReminderAt('2026-07-15T16:00:00Z')),
        Effect.tap(({ events, event }) =>
          Effect.sync(() => {
            expect(events.map((e) => e.event_id)).toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 7: reminder_sent_at already set → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000009',
          'reminder-7',
          '450010000000000009' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 0, time: '18:00' })),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.tap(({ event }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markReminderSent(event.id as any)),
        ),
      ),
      Effect.bind('events', () => findReminderAt('2026-07-15T16:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).not.toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('case 8: all-day, status=cancelled → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000010',
          'reminder-8',
          '450010000000000010' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, { daysBefore: 0, time: '18:00' })),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'cancelled')),
      Effect.bind('events', () => findReminderAt('2026-07-15T16:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).not.toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// _findEventsForClaimRequestAt — mirrors 3 / 3b / 3c
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — findEventsNeedingClaimRequestAt: all-day defers, status relaxed (mirrors case 3/3b/3c)', () => {
  it.effect('mirrors case 3: all-day, status=started → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000011',
          'claim-3',
          '450010000000000011' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, { claimRequestDaysBefore: 3 })),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      // Well within the event's still-live local day.
      Effect.bind('events', () => findClaimRequestAt('2026-07-15T10:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('mirrors case 3b (control): all-day, status=active → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000012',
          'claim-3b',
          '450010000000000012' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, { claimRequestDaysBefore: 3 })),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      Effect.bind('events', () => findClaimRequestAt('2026-07-15T10:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'mirrors case 3c (control): TIMED event, status=started (defensive) → NOT returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '450000000000000013',
            'claim-3c',
            '450010000000000013' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, { claimRequestDaysBefore: 3 })),
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.memberId, '2026-07-20T10:00:05Z', false),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('events', () => findClaimRequestAt('2026-07-15T10:00:00Z')),
        Effect.tap(({ events, event }) =>
          Effect.sync(() => {
            expect(events.map((e) => e.event_id)).not.toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// _findEventsForCoachingStatusAt — mirrors 3 / 3b / 3c
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — findEventsNeedingCoachingStatusAt: all-day defers, status relaxed (mirrors case 3/3b/3c)', () => {
  it.effect('mirrors case 3: all-day, status=started, claimed → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000014',
          'coach-3',
          '450010000000000014' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, {})),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      Effect.tap(({ event, seed }) => setClaimedBy(event.id, seed.memberId)),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      // Same local day, after the 07:00-local gate: 10:00 CEST = 08:00Z.
      Effect.bind('events', () => findCoachingStatusAt('2026-07-15T08:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('mirrors case 3b (control): all-day, status=active, claimed → returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '450000000000000015',
          'coach-3b',
          '450010000000000015' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, {})),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.memberId, '2026-07-14T22:00:00Z', true),
      ),
      Effect.tap(({ event, seed }) => setClaimedBy(event.id, seed.memberId)),
      Effect.bind('events', () => findCoachingStatusAt('2026-07-15T08:00:00Z')),
      Effect.tap(({ events, event }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.event_id)).toContain(event.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'mirrors case 3c (control): TIMED event, status=started (defensive), claimed → NOT returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '450000000000000016',
            'coach-3c',
            '450010000000000016' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, {})),
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.memberId, '2026-07-15T08:00:05Z', false),
        ),
        Effect.tap(({ event, seed }) => setClaimedBy(event.id, seed.memberId)),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('events', () => findCoachingStatusAt('2026-07-15T08:00:00Z')),
        Effect.tap(({ events, event }) =>
          Effect.sync(() => {
            expect(events.map((e) => e.event_id)).not.toContain(event.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
