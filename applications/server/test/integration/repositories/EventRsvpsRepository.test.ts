// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require findYesAttendeesForEmbed to accept an optional member_group_id
// parameter (mirroring the existing findNonRespondersByEventId WITH RECURSIVE
// pattern). They will FAIL to run until the developer implements the server task
// and runs the database migrations.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventRsvpsRepository.Default,
  EventsRepository.Default,
  GroupsRepository.Default,
  RolesRepository.Default,
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

// ---------------------------------------------------------------------------
// coming_later — DB persistence, permissive CHECK, full-attendance semantics
// ---------------------------------------------------------------------------
//
// NOTE: the one-time data conversion (`UPDATE event_rsvps SET response =
// 'coming_later' WHERE response = 'maybe'`, if the migration takes that
// approach) is NOT unit-testable here: migrations run once at `beforeEach`
// via the migrator, against an already-empty/re-migrated schema, so there is
// no pre-migration 'maybe' data in this suite to observe being converted.
// That data-conversion step is covered on staging (verified manually against
// production-shaped data) rather than in this integration suite.

const submitComingLaterRsvp = (
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
  message: Option.Option<string> = Option.some('Running late'),
) =>
  EventRsvpsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.upsertRsvp(eventId, memberId, 'coming_later', message)),
  );

const submitMaybeRsvp = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) =>
  EventRsvpsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.upsertRsvp(eventId, memberId, 'maybe', Option.none())),
  );

describe('EventRsvpsRepository — coming_later persistence', () => {
  it.effect('upsertRsvp persists coming_later; findRsvpByEventAndMember reads it back', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('210000000000000001', 'owner-cl-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('211010101010101010' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.tap(({ event, tm }) =>
        submitComingLaterRsvp(event.id, tm.id, Option.some('Coming after work')),
      ),
      Effect.bind('found', ({ event, tm }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRsvpByEventAndMember(event.id, tm.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          if (Option.isSome(found)) {
            expect(found.value.response).toBe('coming_later');
            expect(Option.getOrNull(found.value.message)).toBe('Coming after work');
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('inserting a legacy maybe response still succeeds (permissive CHECK)', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('210000000000000011', 'owner-cl-11')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('211020202020202020' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.tap(({ event, tm }) => submitMaybeRsvp(event.id, tm.id)),
      Effect.bind('found', ({ event, tm }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRsvpByEventAndMember(event.id, tm.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          if (Option.isSome(found)) {
            expect(found.value.response).toBe('maybe');
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findYesRsvpMemberIdsByEventId includes yes and coming_later, EXCLUDES maybe', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('210000000000000021', 'owner-cl-21')),
      Effect.bind('userId1', () => createUser('210000000000000022', 'user-cl-22')),
      Effect.bind('userId2', () => createUser('210000000000000023', 'user-cl-23')),
      Effect.bind('userId3', () => createUser('210000000000000024', 'user-cl-24')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('211030303030303030' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tmYes', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('tmComingLater', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('tmMaybe', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
      Effect.bind('event', ({ team, tmYes }) => createEvent(team.id, tmYes.id)),
      Effect.tap(({ event, tmYes }) => submitYesRsvp(event.id, tmYes.id)),
      Effect.tap(({ event, tmComingLater }) => submitComingLaterRsvp(event.id, tmComingLater.id)),
      Effect.tap(({ event, tmMaybe }) => submitMaybeRsvp(event.id, tmMaybe.id)),
      Effect.bind('memberIds', ({ event }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findYesRsvpMemberIdsByEventId(event.id)),
        ),
      ),
      Effect.tap(({ memberIds, tmYes, tmComingLater, tmMaybe }) =>
        Effect.sync(() => {
          const ids = (memberIds as ReadonlyArray<{ team_member_id: string }>).map(
            (m) => m.team_member_id,
          );
          expect(ids).toContain(tmYes.id);
          expect(ids).toContain(tmComingLater.id);
          expect(ids).not.toContain(tmMaybe.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'findYesAttendeesForEmbed includes a coming_later member, EXCLUDES a maybe member (maybe no longer counts as attendance)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('210000000000000031', 'owner-cl-31')),
        Effect.bind('userId1', () => createUser('210000000000000032', 'user-cl-32')),
        Effect.bind('userId2', () => createUser('210000000000000033', 'user-cl-33')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('211040404040404040' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('tmComingLater', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('tmMaybe', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.bind('event', ({ team, tmComingLater }) => createEvent(team.id, tmComingLater.id)),
        Effect.tap(({ event, tmComingLater }) => submitComingLaterRsvp(event.id, tmComingLater.id)),
        Effect.tap(({ event, tmMaybe }) => submitMaybeRsvp(event.id, tmMaybe.id)),
        Effect.bind('attendees', ({ event }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findYesAttendeesForEmbed(event.id, 100, Option.none())),
          ),
        ),
        Effect.tap(({ attendees }) =>
          Effect.sync(() => {
            // Only coming_later counts as full attendance now — maybe ("Nevím") is excluded.
            const responses = (attendees as ReadonlyArray<{ response: string }>).map(
              (a) => a.response,
            );
            expect(responses).toEqual(['coming_later']);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'attendees paging orders yes < coming_later < maybe < no (the gradient order, seeded one of each)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('210000000000000041', 'owner-cl-41')),
        Effect.bind('userId1', () => createUser('210000000000000042', 'user-cl-42')),
        Effect.bind('userId2', () => createUser('210000000000000043', 'user-cl-43')),
        Effect.bind('userId3', () => createUser('210000000000000044', 'user-cl-44')),
        Effect.bind('userId4', () => createUser('210000000000000045', 'user-cl-45')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('211050505050505050' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('tmNo', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('tmComingLater', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.bind('tmYes', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
        Effect.bind('tmMaybe', ({ team, userId4 }) => addTeamMember(team.id, userId4)),
        Effect.bind('event', ({ team, tmYes }) => createEvent(team.id, tmYes.id)),
        // Insert in "no, maybe, yes, coming_later" order — deliberately seeding `maybe`
        // BEFORE `coming_later`. If the two ever shared a tied rank (the old behaviour,
        // both at rank 2, broken by `created_at ASC`), this insertion order would leak
        // through as maybe-before-coming_later in the result — the opposite of the
        // required gradient — so this test only passes when the ranks are truly split.
        Effect.tap(({ event, tmNo }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.upsertRsvp(event.id, tmNo.id, 'no', Option.none())),
          ),
        ),
        Effect.tap(({ event, tmMaybe }) => submitMaybeRsvp(event.id, tmMaybe.id)),
        Effect.tap(({ event, tmYes }) => submitYesRsvp(event.id, tmYes.id)),
        Effect.tap(({ event, tmComingLater }) => submitComingLaterRsvp(event.id, tmComingLater.id)),
        Effect.bind('page', ({ event }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findRsvpAttendeesPage(event.id, 0, 10)),
          ),
        ),
        Effect.tap(({ page }) =>
          Effect.sync(() => {
            const responses = (page as ReadonlyArray<{ response: string }>).map((r) => r.response);
            expect(responses).toEqual(['yes', 'coming_later', 'maybe', 'no']);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('a paginated slice (limit 2, offset 2) returns [maybe, no] with no interleaving', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('210000000000000051', 'owner-cl-51')),
      Effect.bind('userId1', () => createUser('210000000000000052', 'user-cl-52')),
      Effect.bind('userId2', () => createUser('210000000000000053', 'user-cl-53')),
      Effect.bind('userId3', () => createUser('210000000000000054', 'user-cl-54')),
      Effect.bind('userId4', () => createUser('210000000000000055', 'user-cl-55')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('211060606060606060' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tmNo', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('tmComingLater', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('tmYes', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
      Effect.bind('tmMaybe', ({ team, userId4 }) => addTeamMember(team.id, userId4)),
      Effect.bind('event', ({ team, tmYes }) => createEvent(team.id, tmYes.id)),
      // Same deliberate ordering as the test above: maybe seeded BEFORE coming_later,
      // so a tied-rank fallback to insertion order would surface as the wrong slice.
      Effect.tap(({ event, tmNo }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertRsvp(event.id, tmNo.id, 'no', Option.none())),
        ),
      ),
      Effect.tap(({ event, tmMaybe }) => submitMaybeRsvp(event.id, tmMaybe.id)),
      Effect.tap(({ event, tmYes }) => submitYesRsvp(event.id, tmYes.id)),
      Effect.tap(({ event, tmComingLater }) => submitComingLaterRsvp(event.id, tmComingLater.id)),
      Effect.bind('page', ({ event }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRsvpAttendeesPage(event.id, 2, 2)),
        ),
      ),
      Effect.tap(({ page }) =>
        Effect.sync(() => {
          const responses = (page as ReadonlyArray<{ response: string }>).map((r) => r.response);
          expect(responses).toEqual(['maybe', 'no']);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Regression: findNonRespondersByEventId / incrementMissedForEventNonResponders gate
// eligibility on `r.name = 'Player' AND r.is_built_in = true` via a DIRECT
// `member_roles` join only. A member who holds the built-in Player role exclusively
// through a group (`group_members` → `role_groups`) is invisible to both queries.
// Fails today.
// ---------------------------------------------------------------------------

const seedPlayerViaGroup = (team: { id: Team.TeamId }, memberId: TeamMember.TeamMemberId) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(team.id)),
      ),
    ),
    Effect.bind('playerRole', () =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findRoleByTeamAndName(team.id, 'Player')),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error('Player role not found')),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.bind('group', () => createGroup(team.id, 'Squad')),
    Effect.tap(({ playerRole, group }) =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.assignRoleToGroup(playerRole.id, group.id)),
      ),
    ),
    Effect.tap(({ group }) => addGroupMember(group.id, memberId)),
  );

describe('EventRsvpsRepository — group-inherited Player role', () => {
  it.effect('findNonRespondersByEventId includes a member whose Player role is group-derived', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('220000000000000001', 'owner-group-player-1')),
      Effect.bind('userId', () => createUser('220000000000000002', 'group-player-member-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('221010101010101010' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ team, member }) => seedPlayerViaGroup(team, member.id)),
      Effect.bind('event', ({ team, member }) => createEvent(team.id, member.id)),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findNonRespondersByEventId(event.id, team.id)),
        ),
      ),
      Effect.tap(({ nonResponders, member }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          expect(ids).toContain(member.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'incrementMissedForEventNonResponders increments a member whose Player role is group-derived',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('220000000000000011', 'owner-group-player-2')),
        Effect.bind('userId', () => createUser('220000000000000012', 'group-player-member-2')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('221020202020202020' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
        Effect.tap(({ team, member }) => seedPlayerViaGroup(team, member.id)),
        Effect.bind('event', ({ team, member }) => createEvent(team.id, member.id)),
        Effect.tap(({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
            ),
          ),
        ),
        Effect.bind('missedRsvpsRows', ({ member }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) =>
                sql<{ missed_rsvps: number }>`
                  SELECT missed_rsvps FROM team_members WHERE id = ${member.id}
                `,
            ),
          ),
        ),
        Effect.tap(({ missedRsvpsRows }) =>
          Effect.sync(() => {
            expect(missedRsvpsRows[0]?.missed_rsvps).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// findRsvpMessageByEventAndDiscordUser — the lean read behind the "edit
// message" modal prefill. It joins event_rsvps -> team_members -> users, so it
// must stay scoped to the (event, team, discord user) triple.
// ---------------------------------------------------------------------------

describe('EventRsvpsRepository — findRsvpMessageByEventAndDiscordUser', () => {
  it.effect("returns the member's stored note", () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('200000000000000101', 'user-note-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('231010101010101010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, member }) => createEvent(team.id, member.id)),
      Effect.tap(({ event, member }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertRsvp(event.id, member.id, 'yes', Option.some('running 10 min late')),
          ),
        ),
      ),
      Effect.bind('note', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findRsvpMessageByEventAndDiscordUser(
              event.id,
              team.id,
              '200000000000000101' as Discord.Snowflake,
            ),
          ),
        ),
      ),
      Effect.tap(({ note }) =>
        Effect.sync(() => {
          expect(note).toEqual(Option.some('running 10 min late'));
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns None for a member who has no RSVP on the event', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('200000000000000102', 'user-note-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('231020202020202020' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, member }) => createEvent(team.id, member.id)),
      Effect.bind('note', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findRsvpMessageByEventAndDiscordUser(
              event.id,
              team.id,
              '200000000000000102' as Discord.Snowflake,
            ),
          ),
        ),
      ),
      Effect.tap(({ note }) =>
        Effect.sync(() => {
          expect(note).toEqual(Option.none());
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns None when the RSVP exists but carries no note', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('200000000000000103', 'user-note-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('231030303030303030' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, member }) => createEvent(team.id, member.id)),
      Effect.tap(({ event, member }) => submitYesRsvp(event.id, member.id)),
      Effect.bind('note', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findRsvpMessageByEventAndDiscordUser(
              event.id,
              team.id,
              '200000000000000103' as Discord.Snowflake,
            ),
          ),
        ),
      ),
      Effect.tap(({ note }) =>
        Effect.sync(() => {
          expect(note).toEqual(Option.none());
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
