// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require:
//   - _findEventsForReminder to accept an optional `now` timestamp parameter
//     (for pinning time in tests) — the current implementation only uses NOW().
//   - The new schema columns: rsvp_reminder_days_before, rsvp_reminder_time,
//     reminders_channel_id, timezone on team_settings.
//   - The new column: member_group_id on event_sync_events.
// They will FAIL to run until the developer implements the server task and
// runs the database migrations.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
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
// Helpers
// ---------------------------------------------------------------------------

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

/** Creates user + team + team_member in one shot and returns the team and the team_member id (FK target for events.created_by). */
const seedTeamWithMember = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, memberId: member.id })),
  );

/** Seed team_settings with the new reminder columns. */
const upsertSettingsWithReminder = (
  teamId: Team.TeamId,
  opts: {
    daysBefore: number;
    time: string;
    timezone: string;
    remindersChannelId?: Option.Option<Discord.Snowflake>;
  },
) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 5,
        rsvpReminderDaysBefore: opts.daysBefore,
        rsvpReminderTime: opts.time,
        timezone: opts.timezone,
        remindersChannelId: opts.remindersChannelId ?? Option.none(),
      }),
    ),
  );

/** Create a minimal active event. */
const createEvent = (teamId: Team.TeamId, createdBy: string, startAt: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Test Training',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date(startAt)),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        discordTargetChannelId: Option.none(),
        createdBy: createdBy as any,
      }),
    ),
  );

/**
 * Calls the refactored _findEventsForReminder with an explicit `now` override.
 * The implementation must expose a `findEventsNeedingReminderAt(now: Date)` method
 * (or equivalent) for test-time pinning.
 */
const findEventsNeedingReminderAt = (now: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEventsNeedingReminderAt(new Date(now))),
  );

// ---------------------------------------------------------------------------
// Tests — time-based window matching
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — _findEventsForReminder with pinned now', () => {
  it.effect(
    'returns event when now = 18:00 CEST (16:00 UTC) and event is 1 day ahead — exact match',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '100000000000000101',
            'owner101',
            '101010101010101010' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) =>
          upsertSettingsWithReminder(seed.team.id, {
            daysBefore: 1,
            time: '18:00',
            timezone: 'Europe/Prague',
          }),
        ),
        // Event starts 1 day from now (2026-04-27 18:00 CEST)
        Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, '2026-04-27T16:00:00Z')),
        Effect.bind('events', () =>
          // now = 2026-04-26 16:00:00 UTC = 18:00 CEST
          findEventsNeedingReminderAt('2026-04-26T16:00:00Z'),
        ),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            expect(Array.isArray(events)).toBe(true);
            expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('does NOT return event when now = 17:00 CEST (15:00 UTC) — 1 hour before window', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '100000000000000102',
          'owner102',
          '102020202020202020' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        upsertSettingsWithReminder(seed.team.id, {
          daysBefore: 1,
          time: '18:00',
          timezone: 'Europe/Prague',
        }),
      ),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, '2026-04-27T16:00:00Z')),
      Effect.bind('events', () =>
        // now = 2026-04-26 15:00:00 UTC = 17:00 CEST — before window
        findEventsNeedingReminderAt('2026-04-26T15:00:00Z'),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(Array.isArray(events)).toBe(true);
          expect((events as unknown[]).length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns event when now = 16:04:59 UTC (within 5-min tolerance)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '100000000000000103',
          'owner103',
          '103030303030303030' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        upsertSettingsWithReminder(seed.team.id, {
          daysBefore: 1,
          time: '18:00',
          timezone: 'Europe/Prague',
        }),
      ),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, '2026-04-27T16:00:00Z')),
      Effect.bind('events', () =>
        // now = 16:04:59 UTC = 18:04:59 CEST — still within +5min tolerance
        findEventsNeedingReminderAt('2026-04-26T16:04:59Z'),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('does NOT return event when now = 16:05:01 UTC (just past 5-min tolerance)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '100000000000000104',
          'owner104',
          '104040404040404040' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        upsertSettingsWithReminder(seed.team.id, {
          daysBefore: 1,
          time: '18:00',
          timezone: 'Europe/Prague',
        }),
      ),
      Effect.tap(({ seed }) => createEvent(seed.team.id, seed.memberId, '2026-04-27T16:00:00Z')),
      Effect.bind('events', () =>
        // now = 16:05:01 UTC = 18:05:01 CEST — past window
        findEventsNeedingReminderAt('2026-04-26T16:05:01Z'),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('per-team timezone: America/New_York fires at 22:00 UTC (= 18:00 EDT)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '100000000000000105',
          'owner105',
          '105050505050505050' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        upsertSettingsWithReminder(seed.team.id, {
          daysBefore: 1,
          time: '18:00',
          timezone: 'America/New_York',
        }),
      ),
      Effect.tap(({ seed }) =>
        // Event 1 day from 2026-04-26 — start_at = 2026-04-27 22:00 UTC
        createEvent(seed.team.id, seed.memberId, '2026-04-27T22:00:00Z'),
      ),
      Effect.bind('events', () =>
        // now = 22:00 UTC = 18:00 EDT
        findEventsNeedingReminderAt('2026-04-26T22:00:00Z'),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('DST boundary CET → CEST: fires at 17:00 UTC (= 18:00 CET) on 2026-03-28', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '100000000000000106',
          'owner106',
          '106060606060606060' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        upsertSettingsWithReminder(seed.team.id, {
          daysBefore: 1,
          time: '18:00',
          timezone: 'Europe/Prague',
        }),
      ),
      Effect.tap(({ seed }) =>
        // Event 1 day from 2026-03-28 → 2026-03-29 17:00 UTC (= 18:00 CET, pre-DST)
        createEvent(seed.team.id, seed.memberId, '2026-03-29T17:00:00Z'),
      ),
      Effect.bind('events', () =>
        // CET is UTC+1, so 18:00 CET = 17:00 UTC
        findEventsNeedingReminderAt('2026-03-28T17:00:00Z'),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('DST boundary CEST: fires at 16:00 UTC (= 18:00 CEST) on 2026-04-04', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '100000000000000107',
          'owner107',
          '107070707070707070' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        upsertSettingsWithReminder(seed.team.id, {
          daysBefore: 1,
          time: '18:00',
          timezone: 'Europe/Prague',
        }),
      ),
      Effect.tap(({ seed }) =>
        // Event 1 day from 2026-04-04 → 2026-04-05 16:00 UTC (= 18:00 CEST, post-DST)
        createEvent(seed.team.id, seed.memberId, '2026-04-05T16:00:00Z'),
      ),
      Effect.bind('events', () =>
        // CEST is UTC+2, so 18:00 CEST = 16:00 UTC
        findEventsNeedingReminderAt('2026-04-04T16:00:00Z'),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
