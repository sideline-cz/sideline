// Integration tests for the missed-RSVP feature:
//   - findNonRespondersByEventId (role filtering + missed_rsvps threshold + group scope)
//   - incrementMissedForEventNonRespondersByEventId
//   - TeamMembersRepository.resetMissedRsvps
//
// These tests require a live PostgreSQL DB (via the integration harness) with
// all migrations applied. If no DB is available the suite is automatically
// skipped by the integration vitest config.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
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
        name: 'Missed RSVP Test Team',
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

/** Seed built-in roles (Admin, Captain, Player, Treasurer) for a team. */
const seedRoles = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
  );

/** Find the built-in Player role id for a team. */
const getPlayerRoleId = (teamId: Team.TeamId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.getPlayerRoleId(teamId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error('Player role not found')),
        onSome: (r) => Effect.succeed(r.id),
      }),
    ),
  );

/** Find a non-Player built-in role (Captain). */
const getCaptainRoleId = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, 'Captain')),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error('Captain role not found')),
        onSome: Effect.succeed,
      }),
    ),
    Effect.map((r) => r.id),
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

const deactivateMember = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.deactivateMemberByIds(teamId, memberId)),
  );

const assignRole = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
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

const createEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
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
        memberGroupId,
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

const submitRsvp = (
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
  response: 'yes' | 'no' | 'maybe' = 'yes',
) =>
  EventRsvpsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.upsertRsvp(eventId, memberId, response, Option.none())),
  );

/** Read missed_rsvps for a given member via raw SQL. */
const getMissedRsvps = (memberId: TeamMember.TeamMemberId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql<{ missed_rsvps: number }>`
        SELECT missed_rsvps FROM team_members WHERE id = ${memberId}
      `.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          if (!row) throw new Error(`member ${memberId} not found`);
          return row.missed_rsvps;
        }),
      ),
    ),
  );

/** Set missed_rsvps directly via raw SQL. */
const setMissedRsvps = (memberId: TeamMember.TeamMemberId, value: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql`UPDATE team_members SET missed_rsvps = ${value} WHERE id = ${memberId}`.pipe(
        Effect.asVoid,
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Seed helper: team + roles + basic members
// ---------------------------------------------------------------------------

/**
 * Seeds a fresh team with built-in roles and two members:
 *   - playerMember: has Player role
 *   - captainMember: has Captain role (non-Player built-in)
 */
const seedTeamWithRoles = (suffix: string) =>
  Effect.Do.pipe(
    Effect.bind('ownerId', () => createUser(`85000000000000${suffix}01`, `owner-mr-${suffix}`)),
    Effect.bind('team', ({ ownerId }) =>
      createTeam(`8600000000000000${suffix}` as Discord.Snowflake, ownerId),
    ),
    Effect.tap(({ team }) => seedRoles(team.id)),
    Effect.bind('playerRoleId', ({ team }) => getPlayerRoleId(team.id)),
    Effect.bind('captainRoleId', ({ team }) => getCaptainRoleId(team.id)),
    Effect.bind('playerUserId', () =>
      createUser(`85000000000000${suffix}02`, `player-mr-${suffix}`),
    ),
    Effect.bind('captainUserId', () =>
      createUser(`85000000000000${suffix}03`, `captain-mr-${suffix}`),
    ),
    Effect.bind('playerMember', ({ team, playerUserId }) => addTeamMember(team.id, playerUserId)),
    Effect.bind('captainMember', ({ team, captainUserId }) =>
      addTeamMember(team.id, captainUserId),
    ),
    Effect.tap(({ playerMember, playerRoleId }) => assignRole(playerMember.id, playerRoleId)),
    Effect.tap(({ captainMember, captainRoleId }) => assignRole(captainMember.id, captainRoleId)),
  );

// ---------------------------------------------------------------------------
// findNonRespondersByEventId — selection tests
// ---------------------------------------------------------------------------

describe('EventRsvpsRepository — findNonRespondersByEventId (missed-RSVP feature)', () => {
  it.effect('Player with missed_rsvps < threshold and no RSVP → INCLUDED', () =>
    seedTeamWithRoles('01').pipe(
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // missed_rsvps = 0 (default) < threshold 4 → included
            repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, playerMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          expect(ids).toContain(playerMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('non-Player member (Captain) → EXCLUDED even when otherwise eligible', () =>
    seedTeamWithRoles('02').pipe(
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, captainMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          // Captain is NOT a Player → excluded
          expect(ids).not.toContain(captainMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('Player with missed_rsvps == threshold → EXCLUDED (strict <)', () =>
    // Set missed_rsvps = 4 and threshold = 4; 4 < 4 is false → excluded
    seedTeamWithRoles('03').pipe(
      Effect.tap(({ playerMember }) => setMissedRsvps(playerMember.id, 4)),
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, playerMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          expect(ids).not.toContain(playerMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('Player with missed_rsvps == threshold-1 → INCLUDED', () =>
    // missed_rsvps = 3, threshold = 4; 3 < 4 → included
    seedTeamWithRoles('04').pipe(
      Effect.tap(({ playerMember }) => setMissedRsvps(playerMember.id, 3)),
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, playerMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          expect(ids).toContain(playerMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('Player who already responded to the target event → EXCLUDED', () =>
    seedTeamWithRoles('05').pipe(
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      // Player submits RSVP
      Effect.tap(({ event, playerMember }) => submitRsvp(event.id, playerMember.id, 'yes')),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, playerMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          expect(ids).not.toContain(playerMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('member_group scope: Player inside subtree → INCLUDED; outside → EXCLUDED', () =>
    seedTeamWithRoles('06').pipe(
      Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
      // Add a second Player who is NOT in the group
      Effect.bind('outsideUserId', () => createUser('850000000000000604', 'outside-player-06')),
      Effect.bind('outsideMember', ({ team, outsideUserId }) =>
        addTeamMember(team.id, outsideUserId),
      ),
      Effect.tap(({ outsideMember, playerRoleId }) => assignRole(outsideMember.id, playerRoleId)),
      // playerMember IS in groupA
      Effect.tap(({ groupA, playerMember }) => addGroupMember(groupA.id, playerMember.id)),
      // outsideMember is NOT in groupA
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.bind('nonResponders', ({ event, team, groupA }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findNonRespondersByEventId(event.id, team.id, Option.some(groupA.id), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, playerMember, outsideMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          expect(ids).toContain(playerMember.id);
          expect(ids).not.toContain(outsideMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('multi-role member (Player + Captain) → INCLUDED exactly once (no duplicates)', () =>
    seedTeamWithRoles('07').pipe(
      // Give playerMember BOTH Player and Captain roles
      Effect.tap(({ playerMember, captainRoleId }) => assignRole(playerMember.id, captainRoleId)),
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, playerMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          const playerOccurrences = ids.filter((id) => id === playerMember.id);
          // Must appear exactly once — no duplicate rows
          expect(playerOccurrences).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('inactive Player → EXCLUDED', () =>
    seedTeamWithRoles('08').pipe(
      Effect.tap(({ team, playerMember }) => deactivateMember(team.id, playerMember.id)),
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.bind('nonResponders', ({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
          ),
        ),
      ),
      Effect.tap(({ nonResponders, playerMember }) =>
        Effect.sync(() => {
          const ids = nonResponders.map((r) => r.team_member_id);
          expect(ids).not.toContain(playerMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'same member flips included/excluded when maxMissedRsvps changes (threshold 1 vs 50)',
    () =>
      // missed_rsvps = 1; threshold 1 → excluded (1 < 1 is false); threshold 50 → included (1 < 50)
      seedTeamWithRoles('09').pipe(
        Effect.tap(({ playerMember }) => setMissedRsvps(playerMember.id, 1)),
        Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
        Effect.bind('excludedAtThreshold1', ({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 1),
            ),
          ),
        ),
        Effect.bind('includedAtThreshold50', ({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 50),
            ),
          ),
        ),
        Effect.tap(({ excludedAtThreshold1, includedAtThreshold50, playerMember }) =>
          Effect.sync(() => {
            expect(excludedAtThreshold1.map((r) => r.team_member_id)).not.toContain(
              playerMember.id,
            );
            expect(includedAtThreshold50.map((r) => r.team_member_id)).toContain(playerMember.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// incrementMissedForEventNonRespondersByEventId
// ---------------------------------------------------------------------------

describe('EventRsvpsRepository — incrementMissedForEventNonRespondersByEventId', () => {
  it.effect('Player non-responder → missed_rsvps incremented by 1', () =>
    seedTeamWithRoles('10').pipe(
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.tap(({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
          ),
        ),
      ),
      Effect.bind('missed', ({ playerMember }) => getMissedRsvps(playerMember.id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          expect(missed).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('member who responded (yes) → missed_rsvps unchanged', () =>
    seedTeamWithRoles('11').pipe(
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.tap(({ event, playerMember }) => submitRsvp(event.id, playerMember.id, 'yes')),
      Effect.tap(({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
          ),
        ),
      ),
      Effect.bind('missed', ({ playerMember }) => getMissedRsvps(playerMember.id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          // responded → not incremented
          expect(missed).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('non-Player non-responder (Captain) → missed_rsvps unchanged', () =>
    seedTeamWithRoles('12').pipe(
      Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
      Effect.tap(({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
          ),
        ),
      ),
      Effect.bind('missedCaptain', ({ captainMember }) => getMissedRsvps(captainMember.id)),
      Effect.tap(({ missedCaptain }) =>
        Effect.sync(() => {
          // Captain has no Player role → not incremented
          expect(missedCaptain).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('Player outside the event member_group subtree → missed_rsvps unchanged', () =>
    seedTeamWithRoles('13').pipe(
      Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
      // playerMember is NOT added to groupA
      Effect.bind('event', ({ team, playerMember, groupA }) =>
        createEvent(team.id, playerMember.id, Option.some(groupA.id)),
      ),
      Effect.tap(({ event, team, groupA }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.incrementMissedForEventNonRespondersByEventId(
              event.id,
              team.id,
              Option.some(groupA.id),
            ),
          ),
        ),
      ),
      Effect.bind('missed', ({ playerMember }) => getMissedRsvps(playerMember.id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          // Player not in the group → not incremented
          expect(missed).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('inactive Player → missed_rsvps unchanged', () =>
    seedTeamWithRoles('14').pipe(
      Effect.tap(({ team, playerMember }) => deactivateMember(team.id, playerMember.id)),
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.tap(({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
          ),
        ),
      ),
      Effect.bind('missed', ({ playerMember }) => getMissedRsvps(playerMember.id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          // inactive → not incremented
          expect(missed).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'calling twice DOES double-count (+2): idempotency is the cron status guard, not this UPDATE',
    () =>
      // CONTRACT: This UPDATE has no per-call idempotency guard. Running it twice increments by 2.
      // The cron prevents double-increment by checking event status (active→started is a one-way
      // transition; startEvent returns None when the event is already started, which skips
      // the increment call entirely).
      seedTeamWithRoles('15').pipe(
        Effect.bind('event', ({ team, playerMember }) => createEvent(team.id, playerMember.id)),
        Effect.tap(({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
            ),
          ),
        ),
        // Second call — deliberately a duplicate to document the contract
        Effect.tap(({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
            ),
          ),
        ),
        Effect.bind('missed', ({ playerMember }) => getMissedRsvps(playerMember.id)),
        Effect.tap(({ missed }) =>
          Effect.sync(() => {
            // Two calls → +2 (no built-in idempotency in the UPDATE itself)
            expect(missed).toBe(2);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// TeamMembersRepository.resetMissedRsvps
// ---------------------------------------------------------------------------

describe('TeamMembersRepository — resetMissedRsvps', () => {
  it.effect('member with missed_rsvps = 3 → becomes 0 after reset', () =>
    seedTeamWithRoles('16').pipe(
      Effect.tap(({ playerMember }) => setMissedRsvps(playerMember.id, 3)),
      Effect.tap(({ playerMember }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.resetMissedRsvps(playerMember.id)),
        ),
      ),
      Effect.bind('missed', ({ playerMember }) => getMissedRsvps(playerMember.id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          expect(missed).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
