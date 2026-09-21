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
import { cleanDatabase, TestPgClient } from '../helpers.js';

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
