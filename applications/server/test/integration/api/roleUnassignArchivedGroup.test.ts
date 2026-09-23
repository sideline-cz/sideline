// Coverage gap 1 (post-fix/role-linking review): the `unassignRole` "still held via a
// group?" guard used to be exercised only against mocks, never against the REAL query.
// This exercises it end-to-end through the real HTTP handler (`api/role.ts`'s
// `unassignRole`), backed by real repositories over a real Postgres instance.
//
// Fixture: group G grants role R (`role_groups`); member M holds R BOTH directly
// (`member_roles`) AND through membership in G. G is then ARCHIVED. Only then is the
// DIRECT grant removed via `DELETE /teams/:teamId/members/:memberId/roles/:roleId`.
//
// Expected: the `role_removed` notification IS created, because an archived group no
// longer grants — M genuinely lost R when the direct grant was deleted. Before the fix,
// the unmigrated "still held?" query saw R through the archived group (it didn't filter
// `is_archived`) and suppressed it, so M was never told they had lost the role.
//
// Sideline roles are no longer mirrored into Discord (`fix/discord-roles-sync`), so the
// notification is this guard's only live consumer.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { RoleApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { RoleApiLive } from '~/api/role.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(RoleApi.RoleApiGroup);

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

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  NotificationsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(RoleApiLive),
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
        name: 'Archived Group Unassign Test Team',
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

const createRoleWithPermissions = (
  teamId: Team.TeamId,
  name: string,
  permissions: ReadonlyArray<Role.Permission>,
) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertRole(teamId, name).pipe(
        Effect.tap((role) => repo.setRolePermissions(role.id, permissions)),
        Effect.map((role) => role.id),
      ),
    ),
  );

const assignRoleDirect = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

const createGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
    ),
    Effect.map((g) => g.id),
  );

const assignRoleToGroup = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRoleToGroup(roleId, groupId)),
  );

const addMemberToGroup = (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.addMemberById(groupId, memberId)));

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

const MEMBER_DISCORD_ID = '910000000000000002';

const seedFixture = () =>
  Effect.Do.pipe(
    Effect.bind('actorUserId', () => createUser('910000000000000001', 'archived-group-actor')),
    Effect.bind('memberUserId', () => createUser(MEMBER_DISCORD_ID, 'archived-group-member')),
    Effect.bind('team', ({ actorUserId }) =>
      createTeam('911010101010101010' as Discord.Snowflake, actorUserId),
    ),
    Effect.bind('actorMemberId', ({ team, actorUserId }) => addTeamMember(team.id, actorUserId)),
    Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
    // Actor needs `role:manage` to call `unassignRole` at all.
    Effect.bind('adminRoleId', ({ team }) =>
      createRoleWithPermissions(team.id, 'Admin', ['role:manage']),
    ),
    Effect.tap(({ actorMemberId, adminRoleId }) => assignRoleDirect(actorMemberId, adminRoleId)),
    // The role under test — granted to the group AND assigned directly to the member.
    Effect.bind('coachRoleId', ({ team }) => createRoleWithPermissions(team.id, 'Coach', [])),
    Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Leadership')),
    Effect.tap(({ coachRoleId, groupId }) => assignRoleToGroup(coachRoleId, groupId)),
    Effect.tap(({ groupId, memberId }) => addMemberToGroup(groupId, memberId)),
    Effect.tap(({ memberId, coachRoleId }) => assignRoleDirect(memberId, coachRoleId)),
    // Archive the group AFTER wiring it up — it no longer grants, but the
    // `group_members` / `role_groups` rows are still present (archiving never deletes
    // them).
    Effect.tap(({ groupId }) => archiveGroup(groupId)),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

const countRoleRemovedNotifications = (userId: User.UserId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM notifications
        WHERE type = 'role_removed' AND user_id = ${userId}
      `,
    ),
    Effect.map((rows) => Number(rows[0]?.count ?? '0')),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('role.ts unassignRole — archived-group guard, end to end', () => {
  it('emits role_unassigned when the only remaining grant is through an ARCHIVED group', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/members/${fixture.memberId}/roles/${fixture.coachRoleId}`,
        {
          method: 'DELETE',
          headers: { Authorization: 'Bearer actor-token' },
        },
      ),
    );

    expect(response.status).toBe(204);

    // The guard's live consumer: before the fix, the unmigrated "still held effectively?"
    // re-check saw the role through the ARCHIVED group and suppressed this, so a member
    // who had genuinely lost the role was never told.
    expect(await countRoleRemovedNotifications(fixture.memberUserId)).toBe(1);
  });
});
