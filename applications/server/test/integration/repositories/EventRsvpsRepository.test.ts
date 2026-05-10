// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require findYesAttendeesForEmbed to accept an optional member_group_id
// parameter (mirroring the existing findNonRespondersByEventId WITH RECURSIVE
// pattern). They will FAIL to run until the developer implements the server task
// and runs the database migrations.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventRsvpsRepository.Default,
  EventsRepository.Default,
  GroupsRepository.Default,
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

const createGroup = (
  teamId: Team.TeamId,
  name: string,
  parentId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, parentId, Option.none(), Option.none()),
    ),
  );

const addGroupMember = (groupId: GroupModel.GroupId, teamMemberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.addMemberById(groupId, teamMemberId)),
  );

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Test Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        discordTargetChannelId: Option.none(),
        createdBy,
      }),
    ),
  );

const submitYesRsvp = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) =>
  EventRsvpsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.upsertRsvp(eventId, memberId, 'yes', Option.none())),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventRsvpsRepository — findYesAttendeesForEmbed with member_group_id', () => {
  it.effect('with member_group_id = None returns all yes-RSVP attendees', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('200000000000000001', 'owner-rsvp-1')),
      Effect.bind('userId1', () => createUser('200000000000000002', 'user-rsvp-2')),
      Effect.bind('userId2', () => createUser('200000000000000003', 'user-rsvp-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('201010101010101010' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('event', ({ team, tm1 }) => createEvent(team.id, tm1.id)),
      Effect.tap(({ event, tm1 }) => submitYesRsvp(event.id, tm1.id)),
      Effect.tap(({ event, tm2 }) => submitYesRsvp(event.id, tm2.id)),
      Effect.bind('attendees', ({ event }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findYesAttendeesForEmbed(event.id, 100, Option.none())),
        ),
      ),
      Effect.tap(({ attendees }) =>
        Effect.sync(() => {
          expect(Array.isArray(attendees)).toBe(true);
          expect((attendees as unknown[]).length).toBe(2);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('with member_group_id = Some(g) returns only attendees in group g', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('200000000000000011', 'owner-rsvp-11')),
      Effect.bind('userId1', () => createUser('200000000000000012', 'user-rsvp-12')),
      Effect.bind('userId2', () => createUser('200000000000000013', 'user-rsvp-13')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('202020202020202020' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
      Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      // Only tm1 is in groupA
      Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
      Effect.bind('event', ({ team, tm1 }) => createEvent(team.id, tm1.id)),
      Effect.tap(({ event, tm1 }) => submitYesRsvp(event.id, tm1.id)),
      Effect.tap(({ event, tm2 }) => submitYesRsvp(event.id, tm2.id)),
      Effect.bind('attendees', ({ event, groupA }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findYesAttendeesForEmbed(event.id, 100, Option.some(groupA.id)),
          ),
        ),
      ),
      Effect.tap(({ attendees }) =>
        Effect.sync(() => {
          // Only tm1 (member of groupA) should appear
          expect(Array.isArray(attendees)).toBe(true);
          expect((attendees as unknown[]).length).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('with member_group_id = Some(parent) includes attendees from descendant groups', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('200000000000000021', 'owner-rsvp-21')),
      Effect.bind('userId1', () => createUser('200000000000000022', 'user-rsvp-22')),
      Effect.bind('userId2', () => createUser('200000000000000023', 'user-rsvp-23')),
      Effect.bind('userId3', () => createUser('200000000000000024', 'user-rsvp-24')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('203030303030303030' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
      Effect.bind('groupB', ({ team, groupA }) =>
        createGroup(team.id, 'Group B', Option.some(groupA.id)),
      ),
      Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('tm3', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
      // tm1 in groupA (parent), tm2 in groupB (child), tm3 in neither
      Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
      Effect.tap(({ groupB, tm2 }) => addGroupMember(groupB.id, tm2.id)),
      Effect.bind('event', ({ team, tm1 }) => createEvent(team.id, tm1.id)),
      Effect.tap(({ event, tm1 }) => submitYesRsvp(event.id, tm1.id)),
      Effect.tap(({ event, tm2 }) => submitYesRsvp(event.id, tm2.id)),
      Effect.tap(({ event, tm3 }) => submitYesRsvp(event.id, tm3.id)),
      Effect.bind('attendees', ({ event, groupA }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findYesAttendeesForEmbed(event.id, 100, Option.some(groupA.id)),
          ),
        ),
      ),
      Effect.tap(({ attendees }) =>
        Effect.sync(() => {
          // tm1 (groupA) and tm2 (groupB child of groupA) — not tm3
          expect(Array.isArray(attendees)).toBe(true);
          expect((attendees as unknown[]).length).toBe(2);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
