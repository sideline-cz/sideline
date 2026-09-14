// TDD — regression test for the "role linking doesn't work" bug (fix/role-linking).
//
// `group.ts`'s `assignGroupRole` handler validates that the target group belongs to
// the team in the URL (`_group.team_id !== teamId` → `GroupNotFound`), but never
// validates that the ROLE being assigned belongs to that same team — unlike
// `role.ts`'s `assignRole` handler, which explicitly checks
// `role.team_id !== teamId` before proceeding (see `api/role.ts:249-251`). Without
// that check, `assignGroupRole` will happily wire up `role_groups(role_id, group_id)`
// across two completely unrelated teams: any team admin can grant one of their
// groups a role belonging to a DIFFERENT team, and every member of that group
// silently inherits whatever permissions that foreign role carries.
//
// This is exercised through the real HTTP handler (`applications/server/src/api/
// group.ts`), backed by real repositories over a real Postgres instance, because the
// assertion that matters is the actual `role_groups` row (or absence of one) — not a
// mocked call count.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { GroupApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { GroupApiLive } from '~/api/group.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
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

const noopMockLayer = <T>(tag: T) =>
  Layer.succeed(
    tag as any,
    new Proxy(
      {},
      {
        get: () => () => Effect.void,
      },
    ),
  );

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  TeamSettingsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(GroupApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(noopMockLayer(ChannelSyncEventsRepository)),
  Layer.provide(noopMockLayer(DiscordChannelsRepository)),
  Layer.provide(noopMockLayer(DiscordChannelMappingRepository)),
  Layer.provide(noopMockLayer(DiscordRolesRepository)),
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

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId, name: string) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name,
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

// A function, NOT a module-level shared promise: each test must call this AFTER its own
// `beforeEach` cleanup has run, or the seeded rows would be wiped by the NEXT test's
// `cleanDatabase()` before that test ever reads them (a real race — the module body
// executes once at import time, well before per-test hooks fire).
const seedFixture = () =>
  Effect.Do.pipe(
    Effect.bind('actorUserId', () => createUser('830000000000000001', 'cross-team-actor')),
    Effect.bind('teamA', ({ actorUserId }) =>
      createTeam('831010101010101010' as Discord.Snowflake, actorUserId, 'Team A'),
    ),
    Effect.bind('actorMemberId', ({ teamA, actorUserId }) => addTeamMember(teamA.id, actorUserId)),
    Effect.bind('managerRoleId', ({ teamA }) =>
      createRoleWithPermissions(teamA.id, 'Manager', ['group:manage']),
    ),
    Effect.tap(({ actorMemberId, managerRoleId }) =>
      assignRoleDirect(actorMemberId, managerRoleId),
    ),
    Effect.bind('group', ({ teamA }) =>
      GroupsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.insertGroup(teamA.id, 'Leadership', Option.none(), Option.none(), Option.none()),
        ),
      ),
    ),
    // A completely unrelated second team, with its own role.
    Effect.bind('otherOwnerUserId', () => createUser('830000000000000002', 'other-team-owner')),
    Effect.bind('teamB', ({ otherOwnerUserId }) =>
      createTeam('831020202020202020' as Discord.Snowflake, otherOwnerUserId, 'Team B'),
    ),
    Effect.bind('foreignRoleId', ({ teamB }) => createRoleWithPermissions(teamB.id, 'Secret', [])),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('group.ts assignGroupRole — must reject roles from a different team', () => {
  it('rejects assigning a role that belongs to a different team, and does not create the link', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.teamA.id}/groups/${fixture.group.id}/roles`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: fixture.foreignRoleId }),
      }),
    );

    // `role.ts`'s `assignRole` rejects a cross-team role with `RoleNotFound` (404).
    // `assignGroupRole` has no equivalent check at all today, so this call wrongly
    // succeeds with 204 — the assertion below fails until the fix adds one.
    expect(response.status).not.toBe(204);

    const groupsForForeignRole = await RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findGroupsForRole(fixture.foreignRoleId)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    expect(groupsForForeignRole).toHaveLength(0);
  });

  it('still allows assigning a role that belongs to the SAME team (control)', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('actor-token', fixture.actorUserId);

    const ownRoleId = await RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.insertRole(fixture.teamA.id, 'Coach')),
      Effect.map((role) => role.id),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.teamA.id}/groups/${fixture.group.id}/roles`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: ownRoleId }),
      }),
    );

    expect(response.status).toBe(204);

    const groupsForOwnRole = await RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findGroupsForRole(ownRoleId)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    expect(groupsForOwnRole.map((g) => g.group_id)).toContain(fixture.group.id);
  });
});
