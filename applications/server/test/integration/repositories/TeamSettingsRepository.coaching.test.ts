// NOTE: These tests cover TeamSettingsRepository.findEventsNeedingCoachingStatusAt.
// The query requires:
//   - events.coaching_status_sent_at (timestamptz nullable)
//   - Only CLAIMED trainings (claimed_by IS NOT NULL), starting later today,
//     after 07:00 local team time, coaching_status_sent_at IS NULL, event status = 'active'.
//
// ASSUMPTION: Result type is EventNeedingCoachingStatus with at minimum:
//   { event_id, team_id, title, start_at, claimed_by, claimer_display_name,
//     claimer_discord_id, owner_group_id, timezone }
//   (the per-type `discord_channel_training` channel was removed — see
//   remove-channel-by-type Release A; channel resolution is done by the caller
//   via the event's owner-group channel mapping.)
//
// ASSUMPTION: The 07:00 cutoff is applied in the team's local timezone.
// ASSUMPTION: Self-healing: once coaching_status_sent_at is NULL and start_at is later
//   today in local time AND now is after 07:00 local → returned. The window is open-ended
//   for the rest of the day (self-healing within the day).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
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
  GroupsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
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

const createGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
    ),
  );

/** Upsert team_settings with the team's timezone via raw SQL. */
const upsertSettings = (teamId: Team.TeamId, timezone: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`
        INSERT INTO team_settings (team_id, event_horizon_days, min_players_threshold,
          rsvp_reminders_enabled, rsvp_reminder_days_before, rsvp_reminder_time, timezone)
        VALUES ('${teamId}', 30, 5, false, 1, '18:00', '${timezone}')
        ON CONFLICT (team_id) DO UPDATE SET
          timezone = '${timezone}'
      `),
    ),
  );

const createTrainingEvent = (
  teamId: Team.TeamId,
  createdBy: string,
  startAtIso: string,
  eventType = 'training',
  ownerGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType,
        title: 'Coach Status Training',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date(startAtIso)),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId,
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy: createdBy as any,
      }),
    ),
  );

/** Mark an event as claimed by a team member via raw SQL. */
const claimEvent = (eventId: string, teamMemberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET claimed_by = '${teamMemberId}' WHERE id = '${eventId}'`),
    ),
  );

/** Mark coaching_status_sent_at via raw SQL. */
const markCoachingStatusSent = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET coaching_status_sent_at = NOW() WHERE id = '${eventId}'`),
    ),
  );

/** Cancel an event via raw SQL. */
const cancelEvent = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET status = 'cancelled' WHERE id = '${eventId}'`),
    ),
  );

const findEventsNeedingCoachingStatusAt = (now: Date) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEventsNeedingCoachingStatusAt(now)),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — findEventsNeedingCoachingStatusAt', () => {
  it.effect(
    'CLAIMED training starting later today after 07:00 local, coaching_status_sent_at NULL → returned with owner_group_id and claimer info',
    () =>
      Effect.Do.pipe(
        // Timezone UTC+2 (CEST). now = 2026-05-01T06:00:00Z = 08:00 CEST (after 07:00).
        // Training starts 2026-05-01T14:00:00Z = 16:00 CEST — later today.
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '600000000000000001',
            'coach-owner-1',
            '601010101010101010' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, 'Europe/Prague')),
        Effect.bind('group', ({ seed }) => createGroup(seed.team.id, 'Coaching Group')),
        Effect.bind('event', ({ seed, group }) =>
          createTrainingEvent(
            seed.team.id,
            seed.memberId,
            '2026-05-01T14:00:00Z',
            'training',
            Option.some(group.id),
          ),
        ),
        Effect.tap(({ event, seed }) => claimEvent(event.id, seed.memberId)),
        // now = 2026-05-01T06:00:00Z = 08:00 CEST — after 07:00 cutoff
        Effect.bind('events', () =>
          findEventsNeedingCoachingStatusAt(new Date('2026-05-01T06:00:00Z')),
        ),
        Effect.tap(({ events, group }) =>
          Effect.sync(() => {
            expect(Array.isArray(events)).toBe(true);
            expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
            const row = (events as any[])[0];
            // owner_group_id should be populated (the caller resolves the target
            // channel from the group's channel mapping)
            expect(Option.isSome(row.owner_group_id)).toBe(true);
            expect(Option.getOrThrow(row.owner_group_id)).toBe(group.id);
            // claimed_by must be present
            expect(row.claimed_by !== null && row.claimed_by !== undefined).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'UNCLAIMED training, same conditions → NOT returned (gate: claimed_by IS NOT NULL)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '600000000000000002',
            'coach-owner-2',
            '602020202020202020' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, 'Europe/Prague')),
        // Same scenario but do NOT claim the event
        Effect.bind('_event', ({ seed }) =>
          createTrainingEvent(seed.team.id, seed.memberId, '2026-05-01T14:00:00Z'),
        ),
        Effect.bind('events', () =>
          findEventsNeedingCoachingStatusAt(new Date('2026-05-01T06:00:00Z')),
        ),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            expect((events as unknown[]).length).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('coaching_status_sent_at already set → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '600000000000000003',
          'coach-owner-3',
          '603030303030303030' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, 'Europe/Prague')),
      Effect.bind('event', ({ seed }) =>
        createTrainingEvent(seed.team.id, seed.memberId, '2026-05-01T14:00:00Z'),
      ),
      Effect.tap(({ event, seed }) => claimEvent(event.id, seed.memberId)),
      Effect.tap(({ event }) => markCoachingStatusSent(event.id)),
      Effect.bind('events', () =>
        findEventsNeedingCoachingStatusAt(new Date('2026-05-01T06:00:00Z')),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'before 07:00 local → NOT returned; after 07:00 → returned (self-healing within the day)',
    () =>
      Effect.Do.pipe(
        // Europe/Prague CEST = UTC+2.
        // Before cutoff: now = 2026-05-01T04:00:00Z = 06:00 CEST (before 07:00) → empty
        // After cutoff:  now = 2026-05-01T06:00:00Z = 08:00 CEST (after 07:00) → returned
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '600000000000000004',
            'coach-owner-4',
            '604040404040404040' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettings(seed.team.id, 'Europe/Prague')),
        Effect.bind('event', ({ seed }) =>
          createTrainingEvent(seed.team.id, seed.memberId, '2026-05-01T14:00:00Z'),
        ),
        Effect.tap(({ event, seed }) => claimEvent(event.id, seed.memberId)),
        Effect.bind('beforeCutoff', () =>
          // 2026-05-01T04:00:00Z = 06:00 CEST — before 07:00 cutoff → empty
          findEventsNeedingCoachingStatusAt(new Date('2026-05-01T04:00:00Z')),
        ),
        Effect.bind('afterCutoff', () =>
          // 2026-05-01T06:00:00Z = 08:00 CEST — after 07:00 cutoff → returned
          findEventsNeedingCoachingStatusAt(new Date('2026-05-01T06:00:00Z')),
        ),
        Effect.tap(({ beforeCutoff, afterCutoff }) =>
          Effect.sync(() => {
            expect((beforeCutoff as unknown[]).length).toBe(0);
            expect((afterCutoff as unknown[]).length).toBeGreaterThanOrEqual(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('cancelled training → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '600000000000000005',
          'coach-owner-5',
          '605050505050505050' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettings(seed.team.id, 'Europe/Prague')),
      Effect.bind('event', ({ seed }) =>
        createTrainingEvent(seed.team.id, seed.memberId, '2026-05-01T14:00:00Z'),
      ),
      Effect.tap(({ event, seed }) => claimEvent(event.id, seed.memberId)),
      Effect.tap(({ event }) => cancelEvent(event.id)),
      Effect.bind('events', () =>
        findEventsNeedingCoachingStatusAt(new Date('2026-05-01T06:00:00Z')),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
