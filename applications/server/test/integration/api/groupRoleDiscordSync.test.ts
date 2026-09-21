// Regression tests: `group.ts`'s `assignGroupRole`, `unassignGroupRole`, `addGroupMember`,
// `removeGroupMember`, `moveGroup`, and `deleteGroup` write `role_groups` / `group_members` /
// `groups.parent_id` / `groups.is_archived` and must emit the matching `role_sync_events` rows —
// without them, attaching a role to a group (or moving/deleting a group, or adding/removing a
// member) granted or revoked nothing in Discord until the bot happened to reconcile that member on
// its own. This file drives the real HTTP handlers (`applications/server/src/api/group.ts`),
// backed by real repositories over a real Postgres instance, and asserts directly on
// `role_sync_events` rows — modelled on
// `test/integration/api/rosterDeactivateGroupManager.test.ts` and
// `test/integration/api/groupAssignRoleCrossTeam.test.ts`.
//
// Two spec items are intentionally NOT covered here, with reasons:
//   - "unlinked team writes no rows": `teams.guild_id` has had a NOT NULL constraint since
//     migration `1741200000_guild_linking.ts` — there is no way to seed a real team row with no
//     guild_id in this schema. `test/integration/repositories/DiscordChannelMappingRepository.test.ts`
//     documents the identical gap for its own "GROUP_TEAM_NO_GUILD" fixture. The closest
//     equivalent this schema supports — "team id not found at all" — is already covered at the
//     repository layer by `RoleSyncEventsRepository.test.ts`'s "inserts nothing when the team
//     cannot be found" test, and is re-covered for the new batch method in
//     `RoleSyncEventsRepository.test.ts`'s extension in this same PR.
//   - "global cap truncates and warns" (600 members): left to the unit-level cap tests in
//     `test/utils/syncGroupRoleMembers.test.ts`, which exercise the same cap/reservation logic
//     without the cost of seeding hundreds of real Postgres rows in one test.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { GroupApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { GroupApiLive } from '~/api/group.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(GroupApi.GroupApiGroup);

let sessionsStore: Map<string, User.UserId>;

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as any);

// Every repository `GroupApiLive` can reach is real and Postgres-backed, not a blind
// `noopMockLayer` proxy: several of the six handlers under test (`moveGroup`'s
// `hasUnprocessedForGroups`, `deleteGroup`'s `findByGroupId`) pattern-match the RESULT of a
// dependency as an `Option`/array, and a `noopMockLayer` (which returns `Effect.void`, i.e.
// `undefined`, for every method) crashes any such handler before it ever reaches the code this
// file exists to test. The real repos behave correctly with no rows seeded for them (an empty
// array / `Option.none()`), which is simpler and safer than hand-writing a correctly-shaped
// partial mock for each.
const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  TeamSettingsRepository.Default,
  RoleSyncEventsRepository.Default,
  DiscordRoleMappingRepository.Default,
  DiscordChannelMappingRepository.Default,
  ChannelSyncEventsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(GroupApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore = new Map();
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

let discordSeq = 0;
const nextDiscordId = () => {
  discordSeq += 1;
  return String(920000000000000000n + BigInt(discordSeq)) as Discord.Snowflake;
};

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
        name: 'Group Role Discord Sync Test Team',
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
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

// Creates a user + active team member in one go, returning both ids — most tests below only
// ever need the member id, but a couple (direct-hold tests) need the user id too.
const createMember = (teamId: Team.TeamId, username: string) =>
  createUser(nextDiscordId(), username).pipe(
    Effect.flatMap((userId) => addTeamMember(teamId, userId).pipe(Effect.map((id) => ({ id })))),
  );

const createRoleWithPermissions = (
  teamId: Team.TeamId,
  name: string,
  permissions: ReadonlyArray<Role.Permission> = [],
) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertRole(teamId, name).pipe(
        Effect.tap((role) => repo.setRolePermissions(role.id, permissions)),
        Effect.map((role) => role.id),
      ),
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
    Effect.map((g) => g.id),
  );

const assignRoleToGroupDirect = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRoleToGroup(roleId, groupId)),
  );

const addMemberToGroupDirect = (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.addMemberById(groupId, memberId)));

const assignRoleDirect = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

const grantRole = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.recordRoleGrant(memberId, roleId)),
  );

const archiveRole = (roleId: Role.RoleId) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveRoleById(roleId)));

// The actor needs `group:manage` to call any of the six handlers under test — granted directly
// (not through a group) so the actor's own permission resolution is never in question.
const seedActor = (teamId: Team.TeamId) =>
  Effect.Do.pipe(
    Effect.bind('actorUserId', () => createUser(nextDiscordId(), 'gr-sync-actor')),
    Effect.bind('actorMemberId', ({ actorUserId }) => addTeamMember(teamId, actorUserId)),
    Effect.bind('managerRoleId', () =>
      createRoleWithPermissions(teamId, 'Manager', ['group:manage']),
    ),
    Effect.tap(({ actorMemberId, managerRoleId }) =>
      assignRoleDirect(actorMemberId, managerRoleId),
    ),
  );

type EventRow = {
  event_type: string;
  role_id: string;
  team_member_id: string | null;
  discord_user_id: string | null;
};

const listEvents = (teamId: Team.TeamId): Promise<ReadonlyArray<EventRow>> =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<EventRow>`
        SELECT event_type, role_id, team_member_id, discord_user_id
        FROM role_sync_events
        WHERE team_id = ${teamId}
        ORDER BY created_at ASC
      `,
    ),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

type SeedR = Layer.Success<typeof SeedLayer>;

const runSeed = <A>(effect: Effect.Effect<A, unknown, SeedR>): Promise<A> =>
  effect.pipe(Effect.provide(SeedLayer), Effect.runPromise);

// ---------------------------------------------------------------------------
// T2 helpers — `channel_sync_events` assertions for addGroupMember / syncRoleMembers.
// ---------------------------------------------------------------------------

type ChannelSyncEventRow = {
  event_type: string;
  entity_type: string;
  group_id: string | null;
};

const listChannelSyncEvents = (teamId: Team.TeamId): Promise<ReadonlyArray<ChannelSyncEventRow>> =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<ChannelSyncEventRow>`
        SELECT event_type, entity_type, group_id
        FROM channel_sync_events
        WHERE team_id = ${teamId}
        ORDER BY created_at ASC
      `,
    ),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

const listMemberAddedGroupIds = async (teamId: Team.TeamId): Promise<ReadonlyArray<string>> => {
  const events = await listChannelSyncEvents(teamId);
  return events
    .filter((e) => e.event_type === 'member_added' && e.entity_type === 'group')
    .map((e) => e.group_id!);
};

const listMemberRemovedGroupIds = async (teamId: Team.TeamId): Promise<ReadonlyArray<string>> => {
  const events = await listChannelSyncEvents(teamId);
  return events
    .filter((e) => e.event_type === 'member_removed' && e.entity_type === 'group')
    .map((e) => e.group_id!);
};

// Seeds a `discord_channel_mappings` row (channel id + role id) for a group, so a missing
// `member_added` emit for that group cannot be explained away as "the group was never
// provisioned" — see this file's header trap note and T2's fixture description.
const provisionGroupMapping = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  DiscordChannelMappingRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insert(teamId, groupId, nextDiscordId(), nextDiscordId())),
  );

// ---------------------------------------------------------------------------
// 1 & 2: assignGroupRole — headline test + child-group inclusion
// ---------------------------------------------------------------------------

describe('group.ts assignGroupRole — must emit role_assigned for the whole descendant subtree', () => {
  it('grants R to Parent members AND Child (descendant) members, but not an unrelated member', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('parentGroupId', ({ team }) => createGroup(team.id, 'Parent')),
        Effect.bind('childGroupId', ({ team, parentGroupId }) =>
          createGroup(team.id, 'Child', Option.some(parentGroupId)),
        ),
        Effect.bind('m1', ({ team }) => createMember(team.id, 'm1-in-child')),
        Effect.bind('m2', ({ team }) => createMember(team.id, 'm2-in-parent')),
        Effect.bind('m3', ({ team }) => createMember(team.id, 'm3-unrelated')),
        Effect.tap(({ childGroupId, m1 }) => addMemberToGroupDirect(childGroupId, m1.id)),
        Effect.tap(({ parentGroupId, m2 }) => addMemberToGroupDirect(parentGroupId, m2.id)),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.parentGroupId}/roles`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ roleId: fixture.roleR }),
        },
      ),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    const assigned = events.filter((e) => e.event_type === 'role_assigned');
    expect(assigned).toHaveLength(2);
    expect(assigned.map((e) => e.team_member_id).sort()).toStrictEqual(
      [fixture.m1.id, fixture.m2.id].sort(),
    );
    expect(assigned.every((e) => e.role_id === fixture.roleR)).toBe(true);
    expect(assigned.some((e) => e.team_member_id === fixture.m3.id)).toBe(false);
  });

  it('emits role_assigned even when the role has NO discord_role_mappings row (bootstrap decision)', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Group')),
        Effect.bind('member', ({ team }) => createMember(team.id, 'member')),
        Effect.tap(({ groupId, member }) => addMemberToGroupDirect(groupId, member.id)),
        Effect.bind('roleId', ({ team }) => createRoleWithPermissions(team.id, 'Unmapped Role')),
        // Confirm the precondition: no mapping row exists for this role before the call.
        Effect.tap(({ team, roleId }) =>
          DiscordRoleMappingRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByRoleId(team.id, roleId)),
            Effect.tap((mapping) => Effect.sync(() => expect(Option.isNone(mapping)).toBe(true))),
          ),
        ),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.groupId}/roles`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: fixture.roleId }),
      }),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    const assigned = events.filter(
      (e) => e.event_type === 'role_assigned' && e.role_id === fixture.roleId,
    );
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.team_member_id).toBe(fixture.member.id);

    // Still no mapping row after the emit — bootstrapping is the BOT's job (`ensureMapping`,
    // triggered when it drains this event), not the server's.
    const mappingAfter = await runSeed(
      DiscordRoleMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findByRoleId(fixture.team.id, fixture.roleId)),
      ),
    );
    expect(Option.isNone(mappingAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3: unassignGroupRole — gated on member_role_grants (anti-stripping guard)
// ---------------------------------------------------------------------------

describe('group.ts unassignGroupRole — must emit role_unassigned only for granted members', () => {
  it('revokes only the member with a member_role_grants row, not the one without', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Parent')),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
        Effect.tap(({ groupId, roleR }) => assignRoleToGroupDirect(roleR, groupId)),
        Effect.bind('granted', ({ team }) => createMember(team.id, 'granted-member')),
        Effect.bind('ungranted', ({ team }) => createMember(team.id, 'ungranted-member')),
        Effect.tap(({ groupId, granted }) => addMemberToGroupDirect(groupId, granted.id)),
        Effect.tap(({ groupId, ungranted }) => addMemberToGroupDirect(groupId, ungranted.id)),
        // Only `granted` has Sideline provenance for this role — `ungranted` must never be
        // stripped (the anti-stripping gate).
        Effect.tap(({ granted, roleR }) => grantRole(granted.id, roleR)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.groupId}/roles/${fixture.roleR}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    const unassigned = events.filter((e) => e.event_type === 'role_unassigned');
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.team_member_id).toBe(fixture.granted.id);
  });

  it('does not emit role_unassigned for a member who still holds the role DIRECTLY', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Group')),
        Effect.bind('roleD', ({ team }) => createRoleWithPermissions(team.id, 'D')),
        Effect.tap(({ groupId, roleD }) => assignRoleToGroupDirect(roleD, groupId)),
        Effect.bind('member', ({ team }) => createMember(team.id, 'both-direct-and-group')),
        Effect.tap(({ groupId, member }) => addMemberToGroupDirect(groupId, member.id)),
        Effect.tap(({ member, roleD }) => assignRoleDirect(member.id, roleD)),
        Effect.tap(({ member, roleD }) => grantRole(member.id, roleD)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.groupId}/roles/${fixture.roleD}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    expect(events.filter((e) => e.event_type === 'role_unassigned')).toHaveLength(0);
  });

  it('does not emit role_unassigned when an ANCESTOR group still grants the role', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('parentGroupId', ({ team }) => createGroup(team.id, 'Parent')),
        Effect.bind('childGroupId', ({ team, parentGroupId }) =>
          createGroup(team.id, 'Child', Option.some(parentGroupId)),
        ),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
        // R is attached to BOTH Parent and Child.
        Effect.tap(({ parentGroupId, roleR }) => assignRoleToGroupDirect(roleR, parentGroupId)),
        Effect.tap(({ childGroupId, roleR }) => assignRoleToGroupDirect(roleR, childGroupId)),
        Effect.bind('member', ({ team }) => createMember(team.id, 'member-in-child')),
        Effect.tap(({ childGroupId, member }) => addMemberToGroupDirect(childGroupId, member.id)),
        Effect.tap(({ member, roleR }) => grantRole(member.id, roleR)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    // Detach from Child only — Parent still grants it.
    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.childGroupId}/roles/${fixture.roleR}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    expect(events.filter((e) => e.event_type === 'role_unassigned')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4: addGroupMember / removeGroupMember
// ---------------------------------------------------------------------------

describe('group.ts addGroupMember / removeGroupMember — must emit the group-derived delta', () => {
  it('addGroupMember emits role_assigned for a role inherited from the parent group', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('parentGroupId', ({ team }) => createGroup(team.id, 'Parent')),
        Effect.bind('childGroupId', ({ team, parentGroupId }) =>
          createGroup(team.id, 'Child', Option.some(parentGroupId)),
        ),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
        Effect.tap(({ parentGroupId, roleR }) => assignRoleToGroupDirect(roleR, parentGroupId)),
        Effect.bind('member', ({ team }) => createMember(team.id, 'new-child-member')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.childGroupId}/members`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId: fixture.member.id }),
        },
      ),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    const assigned = events.filter((e) => e.event_type === 'role_assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.team_member_id).toBe(fixture.member.id);
    expect(assigned[0]?.role_id).toBe(fixture.roleR);
  });

  it('removeGroupMember emits role_unassigned for a role that membership was granting', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Group')),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
        Effect.tap(({ groupId, roleR }) => assignRoleToGroupDirect(roleR, groupId)),
        Effect.bind('member', ({ team }) => createMember(team.id, 'leaving-member')),
        Effect.tap(({ groupId, member }) => addMemberToGroupDirect(groupId, member.id)),
        Effect.tap(({ member, roleR }) => grantRole(member.id, roleR)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.groupId}/members/${fixture.member.id}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    const unassigned = events.filter((e) => e.event_type === 'role_unassigned');
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.team_member_id).toBe(fixture.member.id);
    expect(unassigned[0]?.role_id).toBe(fixture.roleR);
  });
});

// ---------------------------------------------------------------------------
// 5: moveGroup — simultaneous gain and loss
// ---------------------------------------------------------------------------

describe('group.ts moveGroup — must emit both gained and lost roles', () => {
  it('member gains the new ancestor role and loses the old ancestor role', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('oldParentId', ({ team }) => createGroup(team.id, 'OldParent')),
        Effect.bind('newParentId', ({ team }) => createGroup(team.id, 'NewParent')),
        Effect.bind('childId', ({ team, oldParentId }) =>
          createGroup(team.id, 'Child', Option.some(oldParentId)),
        ),
        Effect.bind('roleA', ({ team }) => createRoleWithPermissions(team.id, 'A')),
        Effect.bind('roleB', ({ team }) => createRoleWithPermissions(team.id, 'B')),
        Effect.tap(({ oldParentId, roleA }) => assignRoleToGroupDirect(roleA, oldParentId)),
        Effect.tap(({ newParentId, roleB }) => assignRoleToGroupDirect(roleB, newParentId)),
        Effect.bind('member', ({ team }) => createMember(team.id, 'moved-member')),
        Effect.tap(({ childId, member }) => addMemberToGroupDirect(childId, member.id)),
        Effect.tap(({ member, roleA }) => grantRole(member.id, roleA)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.childId}/parent`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: fixture.newParentId }),
      }),
    );
    expect(response.ok).toBe(true);

    const events = await listEvents(fixture.team.id);
    const forMember = events.filter((e) => e.team_member_id === fixture.member.id);
    expect(
      forMember.filter((e) => e.event_type === 'role_unassigned' && e.role_id === fixture.roleA),
    ).toHaveLength(1);
    expect(
      forMember.filter((e) => e.event_type === 'role_assigned' && e.role_id === fixture.roleB),
    ).toHaveLength(1);
  });

  it('a member reachable through TWO subgroups under the moved group is counted once per direction', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('oldParentId', ({ team }) => createGroup(team.id, 'OldParent')),
        Effect.bind('newParentId', ({ team }) => createGroup(team.id, 'NewParent')),
        Effect.bind('movedId', ({ team, oldParentId }) =>
          createGroup(team.id, 'Moved', Option.some(oldParentId)),
        ),
        Effect.bind('subA', ({ team, movedId }) =>
          createGroup(team.id, 'SubA', Option.some(movedId)),
        ),
        Effect.bind('subB', ({ team, movedId }) =>
          createGroup(team.id, 'SubB', Option.some(movedId)),
        ),
        Effect.bind('roleA', ({ team }) => createRoleWithPermissions(team.id, 'A')),
        Effect.bind('roleB', ({ team }) => createRoleWithPermissions(team.id, 'B')),
        Effect.tap(({ oldParentId, roleA }) => assignRoleToGroupDirect(roleA, oldParentId)),
        Effect.tap(({ newParentId, roleB }) => assignRoleToGroupDirect(roleB, newParentId)),
        Effect.bind('member', ({ team }) => createMember(team.id, 'double-reached-member')),
        // Member of BOTH SubA and SubB — both descendants of the group being moved.
        Effect.tap(({ subA, member }) => addMemberToGroupDirect(subA, member.id)),
        Effect.tap(({ subB, member }) => addMemberToGroupDirect(subB, member.id)),
        Effect.tap(({ member, roleA }) => grantRole(member.id, roleA)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.movedId}/parent`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: fixture.newParentId }),
      }),
    );
    expect(response.ok).toBe(true);

    const events = await listEvents(fixture.team.id);
    const forMember = events.filter((e) => e.team_member_id === fixture.member.id);
    expect(forMember.filter((e) => e.event_type === 'role_unassigned')).toHaveLength(1);
    expect(forMember.filter((e) => e.event_type === 'role_assigned')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6: deleteGroup — whole-subtree revocation, targets captured BEFORE archiving
// ---------------------------------------------------------------------------

describe('group.ts deleteGroup — must revoke the whole subtree, captured before archiving', () => {
  it('archiving Parent revokes R for both a direct Parent member and a Child (descendant) member', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('parentGroupId', ({ team }) => createGroup(team.id, 'Parent')),
        Effect.bind('childGroupId', ({ team, parentGroupId }) =>
          createGroup(team.id, 'Child', Option.some(parentGroupId)),
        ),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
        Effect.tap(({ parentGroupId, roleR }) => assignRoleToGroupDirect(roleR, parentGroupId)),
        Effect.bind('m1', ({ team }) => createMember(team.id, 'm1-in-child')),
        Effect.bind('m2', ({ team }) => createMember(team.id, 'm2-in-parent')),
        Effect.tap(({ childGroupId, m1 }) => addMemberToGroupDirect(childGroupId, m1.id)),
        Effect.tap(({ parentGroupId, m2 }) => addMemberToGroupDirect(parentGroupId, m2.id)),
        Effect.tap(({ m1, roleR }) => grantRole(m1.id, roleR)),
        Effect.tap(({ m2, roleR }) => grantRole(m2.id, roleR)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.parentGroupId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    const unassigned = events.filter((e) => e.event_type === 'role_unassigned');
    // The direct regression pin: `findDescendantMembersWithDiscordIdByGroupId`'s base term
    // requires `is_archived = false`, so if targets were captured AFTER archiving instead of
    // before, this would wrongly be 0.
    expect(unassigned).toHaveLength(2);
    expect(unassigned.map((e) => e.team_member_id).sort()).toStrictEqual(
      [fixture.m1.id, fixture.m2.id].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 7: steady state
// ---------------------------------------------------------------------------

describe('group.ts assignGroupRole — steady state re-run emits nothing new', () => {
  it('re-submitting the same assignGroupRole call emits no additional events', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Group')),
        Effect.bind('member', ({ team }) => createMember(team.id, 'member')),
        Effect.tap(({ groupId, member }) => addMemberToGroupDirect(groupId, member.id)),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const call = () =>
      handler(
        new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.groupId}/roles`, {
          method: 'POST',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ roleId: fixture.roleR }),
        }),
      );

    const first = await call();
    expect(first.status).toBe(204);
    const afterFirst = await listEvents(fixture.team.id);
    // Fails today at 0 — the general bug — before it can even get to the steady-state part.
    expect(afterFirst.filter((e) => e.event_type === 'role_assigned')).toHaveLength(1);

    const second = await call();
    expect(second.status).toBe(204);
    const afterSecond = await listEvents(fixture.team.id);
    expect(afterSecond).toHaveLength(afterFirst.length);
  });
});

// ---------------------------------------------------------------------------
// 8: archived role produces no assign
// ---------------------------------------------------------------------------

describe('group.ts — an archived role attached to a group produces no assign', () => {
  it('a role archived after being attached to a group emits no role_assigned for its members', async () => {
    // `assignGroupRole` itself validates via `roles.findRoleById`, which filters
    // `is_archived = false` — so this cannot be driven through the assign endpoint with an
    // ALREADY-archived role (it would 404 before ever reaching the write, which would prove
    // nothing about the sync logic). Instead: attach while active, seed `group_members`, THEN
    // archive the role directly, and drive the member add through `addGroupMember` — the
    // `findEffectiveRolesForMembers` join on `roles.is_archived = false` (once implemented) must
    // exclude the archived role's grant either way.
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Group')),
        Effect.bind('roleR', ({ team }) => createRoleWithPermissions(team.id, 'R')),
        Effect.tap(({ groupId, roleR }) => assignRoleToGroupDirect(roleR, groupId)),
        Effect.tap(({ roleR }) => archiveRole(roleR)),
        Effect.bind('member', ({ team }) => createMember(team.id, 'joining-member')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.groupId}/members`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: fixture.member.id }),
      }),
    );
    expect(response.status).toBe(204);

    const events = await listEvents(fixture.team.id);
    expect(events.filter((e) => e.role_id === fixture.roleR)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T2 (TDD: fix/archived-ancestor-walk) — addGroupMember / syncRoleMembers must not emit
// `member_added` (channel-sync) for an ARCHIVED ancestor. Chain: A (leaf, active) -> B
// (archived) -> C (active), i.e. A.parent_id = B.id, B.parent_id = C.id. A single archived
// row (`UPDATE groups SET is_archived = true`) leaves B's active descendant A and active
// ancestor C untouched — the bug this PR fixes is that `addGroupMember`/`syncRoleMembers`
// walk ancestors via the archived-BLIND `GroupsRepository.getAncestors`, so they still emit
// `member_added` for B (a group the UI/bot must treat as deleted), which the bot's
// `handleMemberAdded.ts` then turns into `createRoleOnly` — recreating a Discord role for a
// deleted group.
// ---------------------------------------------------------------------------

describe('group.ts addGroupMember / syncRoleMembers — must not emit member_added for an archived ancestor', () => {
  const archiveGroupDirect = (groupId: GroupModel.GroupId) =>
    GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

  const seedArchivedMiddleChain = (archiveMiddle: boolean) =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        createUser(nextDiscordId(), 'owner').pipe(
          Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
        ),
      ),
      Effect.bind('actor', ({ team }) => seedActor(team.id)),
      Effect.bind('groupC', ({ team }) => createGroup(team.id, 'C (top)')),
      Effect.bind('groupB', ({ team, groupC }) =>
        createGroup(team.id, 'B (middle)', Option.some(groupC)),
      ),
      Effect.bind('groupA', ({ team, groupB }) =>
        createGroup(team.id, 'A (leaf)', Option.some(groupB)),
      ),
      // Every group in the chain is provisioned (channel + role mapping) — a missing emit
      // cannot be explained away as "the group has no Discord channel/role yet".
      Effect.tap(({ team, groupA }) => provisionGroupMapping(team.id, groupA)),
      Effect.tap(({ team, groupB }) => provisionGroupMapping(team.id, groupB)),
      Effect.tap(({ team, groupC }) => provisionGroupMapping(team.id, groupC)),
      Effect.tap(({ groupB }) => (archiveMiddle ? archiveGroupDirect(groupB) : Effect.void)),
      Effect.bind('member', ({ team }) => createMember(team.id, 'joining-member')),
    );

  it('addGroupMember on the leaf (A) with an archived middle ancestor (B) emits member_added ONLY for A', async () => {
    const fixture = await runSeed(seedArchivedMiddleChain(true));

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.groupA}/members`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: fixture.member.id }),
      }),
    );
    expect(response.status).toBe(204);

    const groupIds = await listMemberAddedGroupIds(fixture.team.id);
    expect(groupIds).toStrictEqual([fixture.groupA]);
  });

  // POSITIVE CONTROL: identical fixture, B NOT archived — proves the assertion above fails for
  // the right reason (an archived ancestor being severed), not because the fixture never
  // reaches `channel_sync_events` at all (the `_emitIfGuildLinked` null-`guild_id` trap this
  // file's header describes) or because `addGroupMember` never walks ancestors in this fixture
  // shape.
  it('POSITIVE CONTROL: same fixture with NOTHING archived emits member_added for A, B, AND C', async () => {
    const fixture = await runSeed(seedArchivedMiddleChain(false));

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.groupA}/members`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: fixture.member.id }),
      }),
    );
    expect(response.status).toBe(204);

    const groupIds = await listMemberAddedGroupIds(fixture.team.id);
    expect(new Set(groupIds)).toStrictEqual(
      new Set([fixture.groupA, fixture.groupB, fixture.groupC]),
    );
  });

  it('syncRoleMembers on the leaf (A), member already a member of A, emits member_added ONLY for A when B is archived', async () => {
    const fixture = await runSeed(seedArchivedMiddleChain(true));
    await runSeed(
      GroupsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.addMemberById(fixture.groupA, fixture.member.id)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.groupA}/sync-role-members`,
        { method: 'POST', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );
    expect(response.status).toBe(200);

    const groupIds = await listMemberAddedGroupIds(fixture.team.id);
    expect(groupIds).toStrictEqual([fixture.groupA]);
  });

  it('syncRoleMembers remove side is unaffected by the ancestor fix — a roster member NOT in A produces exactly one member_removed for A, none for B or C', async () => {
    const fixture = await runSeed(seedArchivedMiddleChain(true));
    // The roster ("extras" candidates) is every team member, and the actor (`seedActor`) and the
    // fixture's own `member` are both on it — put BOTH in group A so neither counts as an
    // "extra", leaving `extraMember` as the ONLY roster member not in A.
    await runSeed(
      GroupsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          Effect.all([
            repo.addMemberById(fixture.groupA, fixture.member.id),
            repo.addMemberById(fixture.groupA, fixture.actor.actorMemberId),
          ]),
        ),
      ),
    );
    // `extraMember` is on the team roster but never added to group A — syncRoleMembers must
    // treat them as an "extra" to remove from A specifically (`removeEntries` always uses the
    // seed `groupId`, never the ancestor list — this guards against a future edit accidentally
    // narrowing `removeEntries` to only active/unarchived ancestors too).
    await runSeed(createMember(fixture.team.id, 'extra-not-in-a'));

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.groupA}/sync-role-members`,
        { method: 'POST', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );
    expect(response.status).toBe(200);

    const removedGroupIds = await listMemberRemovedGroupIds(fixture.team.id);
    expect(removedGroupIds).toStrictEqual([fixture.groupA]);
    expect(removedGroupIds).not.toContain(fixture.groupB);
    expect(removedGroupIds).not.toContain(fixture.groupC);
  });

  // POSITIVE CONTROL for the `syncRoleMembers` case above: identical fixture, B NOT archived —
  // proves that assertion fails for the right reason (an archived ancestor being severed from
  // the walk), not because `syncRoleMembers` never walks ancestors for this fixture shape at
  // all. Deleting the archived-ancestor filter from `api/group.ts` entirely would still leave
  // the `syncRoleMembers` case above green without this control.
  it('POSITIVE CONTROL: syncRoleMembers on the leaf (A) with NOTHING archived emits member_added for A, B, AND C', async () => {
    const fixture = await runSeed(seedArchivedMiddleChain(false));
    await runSeed(
      GroupsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.addMemberById(fixture.groupA, fixture.member.id)),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/groups/${fixture.groupA}/sync-role-members`,
        { method: 'POST', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );
    expect(response.status).toBe(200);

    const groupIds = await listMemberAddedGroupIds(fixture.team.id);
    expect(new Set(groupIds)).toStrictEqual(
      new Set([fixture.groupA, fixture.groupB, fixture.groupC]),
    );
  });
});

// ---------------------------------------------------------------------------
// 8: moveGroup / createGroup — cycle and cross-team TOCTOU guards
// (regression coverage for `fix/move-group-cycle-toctou`)
//
// These concurrency/guard tests live in THIS file rather than a new one because it already has
// the exact harness they need standing up: the real HTTP `handler` (not a unit-level mock) wired
// to real repositories via `TestLayer`/`SeedLayer`, `beforeAll`, `createUser`, `createTeam`,
// `seedActor`, `createGroup`, `runSeed`, `sessionsStore`, and `MockSessionsRepositoryLayer`. A
// new file would have to re-declare ~200 lines of that setup for no benefit — `moveGroup` and
// `createGroup` are the exact two handlers this file is already built to drive.
//
// Fix contract under test (`api/group.ts`'s `moveGroup` + `createGroup`,
// `repositories/GroupsRepository.ts`):
//   1. `moveGroup` wraps its cycle check + `UPDATE` in `sql.withTransaction`, serialized per
//      team by `SELECT pg_advisory_xact_lock(hashtext(teamId))` (preceded by
//      `SET LOCAL lock_timeout = '5s'`).
//   2. `moveGroup` rejects `parentId === groupId` with 403.
//   3. `moveGroup` rejects a parent whose `team_id !== teamId` with 403.
//   4. `moveGroup` keeps rejecting a parent that is a descendant of the moved group (403) —
//      already-working behaviour, guarded here against regression.
//   5. `createGroup` rejects a `parentId` belonging to another team with 403.
// On current `main`, none of 2/3/5 are checked at all, and the cycle check in 4 has no lock
// around it (see 4 below, which targets exactly that gap without ever writing a real cycle).

const getParentId = (teamId: Team.TeamId, groupId: GroupModel.GroupId): Promise<string | null> =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{
          parent_id: string | null;
        }>`SELECT parent_id FROM groups WHERE id = ${groupId} AND team_id = ${teamId}`,
    ),
    Effect.map((rows) => rows[0]?.parent_id ?? null),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

describe('group.ts moveGroup / createGroup — cycle and cross-team TOCTOU guards', () => {
  it('rejects parentId === groupId (self-parent) with 403 and leaves parent_id untouched', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupAId', ({ team }) => createGroup(team.id, 'A')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    // Deliberately checking the 403 FIRST: on current `main` this call returns 200 and writes
    // `parent_id = id`, a real cycle — and `moveGroup`'s own follow-up `getMemberCount` call
    // then runs an (at time of writing) unguarded recursive CTE over that cycle, which can hang
    // the whole (serial) integration suite. If this assertion ever regresses, STOP — do not let
    // the test proceed to inspect what happens next.
    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.groupAId}/parent`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: fixture.groupAId }),
      }),
    );
    expect(response.status).toBe(403);

    const parentId = await getParentId(fixture.team.id, fixture.groupAId);
    expect(parentId).toBeNull();
  });

  it('moveGroup rejects a parent belonging to a different team with 403 and leaves parent_id untouched', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team1', () =>
          createUser(nextDiscordId(), 'owner1').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('team2', () =>
          createUser(nextDiscordId(), 'owner2').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team1 }) => seedActor(team1.id)),
        Effect.bind('team1GroupId', ({ team1 }) => createGroup(team1.id, 'Team1 Group')),
        Effect.bind('team2GroupId', ({ team2 }) => createGroup(team2.id, 'Team2 Group')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team1.id}/groups/${fixture.team1GroupId}/parent`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId: fixture.team2GroupId }),
        },
      ),
    );
    expect(response.status).toBe(403);

    const parentId = await getParentId(fixture.team1.id, fixture.team1GroupId);
    expect(parentId).toBeNull();
  });

  it('createGroup rejects a parentId belonging to a different team with 403', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team1', () =>
          createUser(nextDiscordId(), 'owner1').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('team2', () =>
          createUser(nextDiscordId(), 'owner2').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team1 }) => seedActor(team1.id)),
        Effect.bind('team2GroupId', ({ team2 }) => createGroup(team2.id, 'Team2 Group')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team1.id}/groups`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cross Team Child',
          parentId: fixture.team2GroupId,
          emoji: null,
          color: null,
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('moveGroup rejects moving a group under its own descendant with 403 (regression guard)', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupAId', ({ team }) => createGroup(team.id, 'A')),
        Effect.bind('groupBId', ({ team, groupAId }) =>
          createGroup(team.id, 'B', Option.some(groupAId)),
        ),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    // A is root, B is a child of A. Moving A under B would create a cycle (A -> B -> A).
    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/groups/${fixture.groupAId}/parent`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: fixture.groupBId }),
      }),
    );
    expect(response.status).toBe(403);

    const parentId = await getParentId(fixture.team.id, fixture.groupAId);
    expect(parentId).toBeNull();
  });

  it('a concurrent moveGroup blocks on the per-team advisory lock and resumes once it is released', async () => {
    const fixture = await runSeed(
      Effect.Do.pipe(
        Effect.bind('team', () =>
          createUser(nextDiscordId(), 'owner').pipe(
            Effect.flatMap((ownerId) => createTeam(nextDiscordId(), ownerId)),
          ),
        ),
        Effect.bind('actor', ({ team }) => seedActor(team.id)),
        Effect.bind('groupAId', ({ team }) => createGroup(team.id, 'A')),
        Effect.bind('groupBId', ({ team }) => createGroup(team.id, 'B')),
      ),
    );

    sessionsStore.set('actor-token', fixture.actor.actorUserId);

    await Effect.scoped(
      Effect.Do.pipe(
        Effect.bind('sql2', () => secondTestPgClient),
        // Session-level lock, awaited (not fired-and-forgotten) — this guarantees the
        // happens-before: the lock is DEFINITELY held on `sql2` before the PATCH request below
        // is ever issued. No sleep-based ordering needed for this part.
        Effect.tap(({ sql2 }) => sql2`SELECT pg_advisory_lock(hashtext(${fixture.team.id}))`),
        Effect.let('responsePromise', () =>
          handler(
            new Request(
              `http://localhost/teams/${fixture.team.id}/groups/${fixture.groupAId}/parent`,
              {
                method: 'PATCH',
                headers: {
                  Authorization: 'Bearer actor-token',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ parentId: fixture.groupBId }),
              },
            ),
          ),
        ),
        // On current `main` there is no per-team advisory lock at all, so the request above
        // completes almost immediately — this race resolves to 'response', not 'timeout', and
        // the assertion below fails. That failure IS the regression signal for this test. The
        // window (400ms) is deliberately well under the fix's `lock_timeout = '5s'`, so once the
        // lock IS taken by `moveGroup`, the blocked request is still waiting, not erroring out.
        Effect.bind('winner', ({ responsePromise }) =>
          Effect.promise(() =>
            Promise.race([
              responsePromise.then(() => 'response' as const),
              new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 400)),
            ]),
          ),
        ),
        Effect.tap(({ winner }) => Effect.sync(() => expect(winner).toBe('timeout'))),
        Effect.tap(({ sql2 }) => sql2`SELECT pg_advisory_unlock(hashtext(${fixture.team.id}))`),
        Effect.bind('response', ({ responsePromise }) => Effect.promise(() => responsePromise)),
        Effect.tap(({ response }) => Effect.sync(() => expect(response.status).toBe(200))),
      ),
    ).pipe(Effect.runPromise);

    const parentId = await getParentId(fixture.team.id, fixture.groupAId);
    expect(parentId).toBe(fixture.groupBId);
  });
});
