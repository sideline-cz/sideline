// TDD — regression test for the "role linking doesn't work" bug (fix/role-linking).
//
// `roster.ts`'s `deactivateMember` handler decides whether the member being removed is
// a team manager by reading `member.permissions.includes('team:manage')` off the row
// returned by `TeamMembersRepository.findRosterMemberByIds` (see the `member` binding
// feeding `deactivateMemberAndCascade`'s `memberHoldsManage` argument). That repository
// method's underlying SQL (`findRosterMemberQuery` in `TeamMembersRepository.ts`) only
// looks at `member_roles` — it ignores `group_members` → `groups.parent_id` ancestry →
// `role_groups`, the group-inheritance half of the effective-roles model.
//
// Consequence: a member who holds `team:manage` *only* through a group is treated as
// holding NO permissions at all by this handler. `memberHoldsManage` is computed as
// `false`, so `deactivateMemberAndCascade` skips the `hasOtherActiveManager` "last active
// manager" guard entirely (see `deactivateMemberCascade.ts`: the guard is only consulted
// `when memberHoldsManage`) — and the team's only manager can be deactivated with no
// refusal, silently orphaning the team.
//
// This must be exercised through the real HTTP handler (`applications/server/src/api/
// roster.ts`), backed by real repositories over a real Postgres instance — NOT through
// `deactivateMemberAndCascade` directly, because `DeactivateMemberCascade.test.ts` calls
// that util with `memberHoldsManage` passed in as a literal, which passes whether or not
// the bug in `findRosterMemberByIds` is fixed. The bug lives entirely in the SQL query
// that computes `memberHoldsManage`'s input, one layer above the util.
//
// Fixture: TARGET is the team's only `team:manage` holder, and holds it *exclusively*
// through group membership (a "Leadership" group with a custom "Manager" role assigned
// via `role_groups`). ACTOR is a distinct member (deactivating yourself is separately
// blocked by `roster.ts:407-410`, hence two members) who can call the endpoint at all
// only because ACTOR's own `member:remove` permission is *also* granted exclusively
// through a group ("Support" group / "Support" role) — exercising the group-linking fix
// on both sides of the request. Nobody on the team holds `team:manage` directly, and no
// built-in roles are seeded, so TARGET is unambiguously the sole possible manager.
//
// Expected (fixed) behavior: deactivating TARGET must be refused with `Roster.Forbidden`
// (403) — the last-active-manager guard must fire. Today, the response is a plain
// success (204) and the target is deactivated, because `memberHoldsManage` is (wrongly)
// `false`.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { Roster } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { RosterApiLive } from '~/api/roster.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// See `teamSettingsReanchor.test.ts` for the full explanation of why a `SmallApi`
// containing only the group under test is sufficient here.
const SmallApi = HttpApi.make('api').add(Roster.RosterApiGroup);

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

// `roster.ts`'s handlers for OTHER endpoints in the group reference these repositories,
// so the group's Layer requires them at construction time even though `deactivateMember`
// itself never calls them. A permissive no-op proxy is enough — none of these tests
// exercise Discord channel provisioning.
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
  RostersRepository.Default,
  TeamSettingsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(RosterApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(noopMockLayer(ChannelSyncEventsRepository)),
  Layer.provide(noopMockLayer(DiscordChannelsRepository)),
  Layer.provide(noopMockLayer(DiscordChannelMappingRepository)),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

// A separate layer instance for direct repository access (seeding), same underlying
// Postgres, no HTTP involved.
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
        name: 'Deactivate Group Manager Test Team',
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

const createGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
    ),
    Effect.map((g) => g.id),
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

const assignRoleToGroup = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRoleToGroup(roleId, groupId)),
  );

const addMemberToGroup = (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.addMemberById(groupId, memberId)));

// A function, NOT a module-level shared promise: each test must call this AFTER its own
// `beforeEach` cleanup has run, or the seeded rows would be wiped by the NEXT test's
// `cleanDatabase()` before that test ever reads them (a real race — the module body
// executes once at import time, well before per-test hooks fire).
const seedFixture = () =>
  Effect.Do.pipe(
    Effect.bind('actorUserId', () => createUser('810000000000000001', 'group-manager-actor')),
    Effect.bind('targetUserId', () => createUser('810000000000000002', 'group-manager-target')),
    Effect.bind('team', ({ actorUserId }) =>
      createTeam('811010101010101010' as Discord.Snowflake, actorUserId),
    ),
    Effect.bind('actorMemberId', ({ team, actorUserId }) => addTeamMember(team.id, actorUserId)),
    Effect.bind('targetMemberId', ({ team, targetUserId }) => addTeamMember(team.id, targetUserId)),
    // Group + role granting `team:manage` (and `member:remove`) — TARGET's ONLY source of
    // management permission on this team.
    Effect.bind('leadershipGroupId', ({ team }) => createGroup(team.id, 'Leadership')),
    Effect.bind('managerRoleId', ({ team }) =>
      createRoleWithPermissions(team.id, 'Manager', ['team:manage', 'member:remove']),
    ),
    Effect.tap(({ managerRoleId, leadershipGroupId }) =>
      assignRoleToGroup(managerRoleId, leadershipGroupId),
    ),
    Effect.tap(({ leadershipGroupId, targetMemberId }) =>
      addMemberToGroup(leadershipGroupId, targetMemberId),
    ),
    // Separate group + role granting only `member:remove` — ACTOR's ONLY source of the
    // permission required to call `deactivateMember` at all. ACTOR deliberately does NOT
    // hold `team:manage` through any path.
    Effect.bind('supportGroupId', ({ team }) => createGroup(team.id, 'Support')),
    Effect.bind('supportRoleId', ({ team }) =>
      createRoleWithPermissions(team.id, 'Support', ['member:remove']),
    ),
    Effect.tap(({ supportRoleId, supportGroupId }) =>
      assignRoleToGroup(supportRoleId, supportGroupId),
    ),
    Effect.tap(({ supportGroupId, actorMemberId }) =>
      addMemberToGroup(supportGroupId, actorMemberId),
    ),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('roster.ts deactivateMember — last-manager guard must see group-derived team:manage', () => {
  it('refuses to deactivate the team-manage-only-via-group last manager, from the API handler', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/members/${fixture.targetMemberId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );

    // TARGET is the team's only `team:manage` holder (exclusively through the
    // "Leadership" group). Removing them must be refused as the last active manager —
    // today the buggy group-blind `findRosterMemberByIds` makes the handler believe
    // TARGET holds no permissions at all, so the guard never runs and this wrongly
    // succeeds with 204.
    expect(response.status).toBe(403);

    const stillActive = await TeamMembersRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findById(fixture.targetMemberId)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    expect(Option.isSome(stillActive)).toBe(true);
    if (Option.isSome(stillActive)) {
      expect(stillActive.value.active).toBe(true);
    }
  });
});

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

// Coverage gap 6 (post-fix/role-linking review): the last-manager guard
// (`hasOtherActiveManager`, built on `effectiveRolesFrom`) must NOT let an archived
// group's `team:manage` grant count as "another manager" — the orphan-the-team failure
// mode this whole fix targets. `rosterDeactivateGroupManager.test.ts`'s existing test
// only covers the LIVE-group case (TARGET's own `team:manage`); this covers the OTHER
// member whose only `team:manage` grant is through an archived group.
//
// Fixture: TARGET holds `team:manage` DIRECTLY (the unambiguous real last manager).
// OTHER is a third member whose `team:manage` comes ONLY through a group that is then
// archived. ACTOR (member:remove only) tries to deactivate TARGET. If the archived
// group's grant wrongly counted, `hasOtherActiveManager` would see OTHER as a second
// manager and let TARGET be deactivated — silently leaving the team with a "manager"
// (OTHER) who cannot actually manage anything. Expected (correct) behavior: refused,
// same as if OTHER did not exist at all.
const seedArchivedOtherManagerFixture = () =>
  Effect.Do.pipe(
    Effect.bind('actorUserId', () =>
      createUser('812000000000000001', 'archived-other-manager-actor'),
    ),
    Effect.bind('targetUserId', () =>
      createUser('812000000000000002', 'archived-other-manager-target'),
    ),
    Effect.bind('otherUserId', () =>
      createUser('812000000000000003', 'archived-other-manager-other'),
    ),
    Effect.bind('team', ({ actorUserId }) =>
      createTeam('813010101010101010' as Discord.Snowflake, actorUserId),
    ),
    Effect.bind('actorMemberId', ({ team, actorUserId }) => addTeamMember(team.id, actorUserId)),
    Effect.bind('targetMemberId', ({ team, targetUserId }) => addTeamMember(team.id, targetUserId)),
    Effect.bind('otherMemberId', ({ team, otherUserId }) => addTeamMember(team.id, otherUserId)),
    // ACTOR's only permission — `member:remove`, held directly, no group involved.
    Effect.bind('supportRoleId', ({ team }) =>
      createRoleWithPermissions(team.id, 'Support', ['member:remove']),
    ),
    Effect.tap(({ actorMemberId, supportRoleId }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.assignRole(actorMemberId, supportRoleId)),
      ),
    ),
    // TARGET — the unambiguous, real last manager: `team:manage` held DIRECTLY.
    Effect.bind('managerRoleId', ({ team }) =>
      createRoleWithPermissions(team.id, 'Manager', ['team:manage']),
    ),
    Effect.tap(({ targetMemberId, managerRoleId }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.assignRole(targetMemberId, managerRoleId)),
      ),
    ),
    // OTHER — `team:manage` ONLY through a group, which is then archived. Must NOT
    // count as another active manager.
    Effect.bind('leadershipGroupId', ({ team }) => createGroup(team.id, 'Leadership')),
    Effect.tap(({ managerRoleId, leadershipGroupId }) =>
      assignRoleToGroup(managerRoleId, leadershipGroupId),
    ),
    Effect.tap(({ leadershipGroupId, otherMemberId }) =>
      addMemberToGroup(leadershipGroupId, otherMemberId),
    ),
    Effect.tap(({ leadershipGroupId }) => archiveGroup(leadershipGroupId)),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

describe('roster.ts deactivateMember — an archived group must NOT count as "another manager"', () => {
  it('refuses to deactivate the real last manager even though a third member holds team:manage through an archived group', async () => {
    const fixture = await seedArchivedOtherManagerFixture();
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/members/${fixture.targetMemberId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );

    // OTHER's `team:manage` grant is severed by the archived group — TARGET is
    // genuinely the team's only manager, so this must be refused exactly as if OTHER
    // held no permissions at all. If the archived group wrongly counted, this would
    // (wrongly) succeed with 204 and orphan the team with a powerless "manager".
    expect(response.status).toBe(403);

    const stillActive = await TeamMembersRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findById(fixture.targetMemberId)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    expect(Option.isSome(stillActive)).toBe(true);
    if (Option.isSome(stillActive)) {
      expect(stillActive.value.active).toBe(true);
    }
  });
});
