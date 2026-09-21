// TDD mode — written BEFORE `SearchApiLive` (`applications/server/src/api/search.ts`) exists.
// Plan `.work-plans/command-palette-search.md` §F.4. Uses the lightweight "SmallApi" harness
// (`test/integration/api/bankSync.test.ts` / `teamSettingsReanchor.test.ts` precedent): an
// `HttpApi` containing ONLY `SearchApi.SearchApiGroup`, served over REAL repositories against
// `TestPgClient`, with a hand-rolled `SessionsRepository` mock (token -> userId map) standing in
// for cookie-based auth. This deliberately does NOT pull in the full `ApiLive` — that
// cross-cutting wiring is the implementation's job, not this test file's (§F.3 already covers the
// full-`ApiLive` HTTP surface with mocked repositories).
//
// This file imports `SearchApiLive` from `~/api/search.js` directly, so — unlike
// `test/api/search.test.ts` (§F.3), which goes through the pre-existing `ApiLive` and currently
// 404s — every test here fails at MODULE RESOLUTION time right now ("Cannot find module
// '~/api/search.js'"), exactly like `test/unit/searchRanking.test.ts` (§F.2). That is this file's
// TDD-red state; do not add a stub to make it pass.
//
// **A resolved plan/code ambiguity, flagged per the task's instruction to surface disagreements
// rather than silently guess:** §F.4 point 1's prose ("an event in a grandchild group is visible
// to a member of the parent group") reads BACKWARDS relative to the shipped
// `GroupsRepository.getDescendantMemberIds` recursion this test is supposed to exercise.
// `findDescendantMembers` (`GroupsRepository.ts:368-381`) walks DOWN from the given group id to
// its CHILDREN (`g.parent_id = d.id`), so `checkGroupAccess`/`canSeeGroup` (`scoping.ts:30-39`,
// `toolTypes.ts`'s `makeCanSeeGroup`) answers true only for a caller who is a member of the
// event's own group OR one of ITS DESCENDANTS — never an ancestor of it. This is independently
// confirmed by `GroupsRepository.test.ts`'s own `member_count` tests ("parent has 1 member, child
// has 1 different member -> parent.memberCount = 2, child.memberCount = 1"): a parent group's
// count/visibility aggregates DOWNWARD from children, not the reverse. So "an event in a
// grandchild group visible to a member of the parent group" cannot be correct as literally
// written — a member of an ANCESTOR group is never a "descendant member" of a narrower group
// nested below it. This file instead tests the direction the code actually implements: an event
// assigned to the TOP-LEVEL (ancestor) group of a three-deep chain is visible to a member nested
// at the GRANDCHILD (descendant) level, and invisible to an unrelated member — i.e. broader-group
// events are visible to everyone nested below them, not the other way around. Flagged for the
// architect/developer to confirm against the plan's intent.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { SearchApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { SearchApiLive } from '~/api/search.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Harness — the "SmallApi" pattern.
// ---------------------------------------------------------------------------

const SmallApi = HttpApi.make('api').add(SearchApi.SearchApiGroup);

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
} as never);

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  EventsRepository.Default,
  TrainingTypesRepository.Default,
  RostersRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(SearchApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provideMerge(RealRepos),
  Layer.provideMerge(TestPgClient),
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

// This annotation (matching `bankSync.test.ts`'s own `handler` type exactly) currently produces
// a SECOND, cascading `tsc` error beyond the expected "Cannot find module '~/api/search.js'":
// `HttpRouter.toWebHandler`'s leftover-requirements inference (`HR`) picks a 2-arg handler
// overload once `SearchApiLive` resolves to `any` (the unresolved-import fallback), instead of
// eliminating every requirement the way a real, correctly-typed `SearchApiLive` would. Expected
// to resolve on its own once `search.ts` exists — not a design defect in this harness.
let handler: (request: Request) => Promise<Response>;
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

const HOST = 'http://localhost';

const search = (teamId: Team.TeamId, token: string, query: string) =>
  handler(
    new Request(`${HOST}/teams/${teamId}/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

// ---------------------------------------------------------------------------
// Seeding helpers — modelled on `middleGroupArchivedChain.test.ts`.
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
        name: 'Search Integration Test Team',
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

const addMemberToGroup = (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.addMemberById(groupId, memberId)));

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

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

const assignRoleToMember = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

const createEvent = (
  teamId: Team.TeamId,
  title: string,
  createdBy: TeamMember.TeamMemberId,
  memberGroupId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        trainingTypeId: Option.none(),
        eventType: 'training',
        title,
        description: Option.none(),
        startAt: DateTime.makeUnsafe('2026-06-01T10:00:00.000Z'),
        endAt: Option.none(),
        location: Option.none(),
        createdBy,
        memberGroupId,
      }),
    ),
  );

const createTrainingType = (teamId: Team.TeamId, name: string) =>
  TrainingTypesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insertTrainingType(teamId, name, Option.none())),
  );

const createRoster = (teamId: Team.TeamId, name: string) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name,
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
  );

let guildIdCounter = 950_100_000_000_000_000n;
const nextGuildId = (): Discord.Snowflake => (guildIdCounter++).toString() as Discord.Snowflake;
let discordIdCounter = 960_100_000_000_000_000n;
const nextDiscordId = (): string => (discordIdCounter++).toString();

// ---------------------------------------------------------------------------
// 1 — nested group visibility (the real recursion). See header comment for the resolved
// grandchild/parent direction.
// ---------------------------------------------------------------------------

describe('search API — nested group visibility (real getDescendantMemberIds recursion) (1)', () => {
  it.effect(
    'an event assigned to the TOP group is visible to a member nested at the GRANDCHILD level, invisible to an unrelated member',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser(nextDiscordId(), 'chain-owner');
        const team = yield* createTeam(nextGuildId(), ownerId);

        const groupTop = yield* createGroup(team.id, 'Top');
        const groupMid = yield* createGroup(team.id, 'Mid', Option.some(groupTop));
        const groupLeaf = yield* createGroup(team.id, 'Grandchild', Option.some(groupMid));

        const creatorId = yield* createUser(nextDiscordId(), 'creator');
        const creatorMember = yield* addTeamMember(team.id, creatorId);
        yield* createEvent(team.id, 'Chain Visible Event', creatorMember, Option.some(groupTop));

        const nestedUserId = yield* createUser(nextDiscordId(), 'nested-member');
        const nestedMemberId = yield* addTeamMember(team.id, nestedUserId);
        yield* addMemberToGroup(groupLeaf, nestedMemberId);
        sessionsStore.set('nested-token', nestedUserId);

        const unrelatedUserId = yield* createUser(nextDiscordId(), 'unrelated-member');
        yield* addTeamMember(team.id, unrelatedUserId);
        sessionsStore.set('unrelated-token', unrelatedUserId);

        const nestedResponse = yield* Effect.promise(() =>
          search(team.id, 'nested-token', 'Chain Visible'),
        );
        expect(nestedResponse.status).toBe(200);
        const nestedBody = (yield* Effect.promise(() => nestedResponse.json())) as ReadonlyArray<{
          kind: string;
          event?: { title: string };
        }>;
        expect(
          nestedBody.some((h) => h.kind === 'event' && h.event?.title === 'Chain Visible Event'),
        ).toBe(true);

        const unrelatedResponse = yield* Effect.promise(() =>
          search(team.id, 'unrelated-token', 'Chain Visible'),
        );
        expect(unrelatedResponse.status).toBe(200);
        const unrelatedBody = (yield* Effect.promise(() =>
          unrelatedResponse.json(),
        )) as ReadonlyArray<{ kind: string }>;
        expect(unrelatedBody.some((h) => h.kind === 'event')).toBe(false);
      }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 2 — an archived group in the middle of the chain severs it (mirrors
// `middleGroupArchivedChain.test.ts`'s finding for role inheritance — this is the same recursion
// applied to event group-visibility instead).
// ---------------------------------------------------------------------------

describe('search API — archived middle group severs the chain (2)', () => {
  it.effect(
    'archiving the MIDDLE group stops the grandchild-nested member from seeing the top-assigned event',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser(nextDiscordId(), 'chain-owner-2');
        const team = yield* createTeam(nextGuildId(), ownerId);

        const groupTop = yield* createGroup(team.id, 'Top2');
        const groupMid = yield* createGroup(team.id, 'Mid2', Option.some(groupTop));
        const groupLeaf = yield* createGroup(team.id, 'Grandchild2', Option.some(groupMid));

        const creatorId = yield* createUser(nextDiscordId(), 'creator2');
        const creatorMember = yield* addTeamMember(team.id, creatorId);
        yield* createEvent(team.id, 'Severed Event', creatorMember, Option.some(groupTop));

        const nestedUserId = yield* createUser(nextDiscordId(), 'nested-member-2');
        const nestedMemberId = yield* addTeamMember(team.id, nestedUserId);
        yield* addMemberToGroup(groupLeaf, nestedMemberId);
        sessionsStore.set('nested-token-2', nestedUserId);

        // Control: visible before archiving.
        const before = yield* Effect.promise(() => search(team.id, 'nested-token-2', 'Severed'));
        const beforeBody = (yield* Effect.promise(() => before.json())) as ReadonlyArray<{
          kind: string;
        }>;
        expect(beforeBody.some((h) => h.kind === 'event')).toBe(true);

        yield* archiveGroup(groupMid);

        const after = yield* Effect.promise(() => search(team.id, 'nested-token-2', 'Severed'));
        expect(after.status).toBe(200);
        const afterBody = (yield* Effect.promise(() => after.json())) as ReadonlyArray<{
          kind: string;
        }>;
        expect(afterBody.some((h) => h.kind === 'event')).toBe(false);
      }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 3 — cross-team isolation against real SQL, for all five kinds.
// ---------------------------------------------------------------------------

describe('search API — cross-team isolation, real SQL, all five kinds (3)', () => {
  it.effect('identical names in two teams: each caller sees only their own team rows', () =>
    Effect.gen(function* () {
      const owner1 = yield* createUser(nextDiscordId(), 'owner-x1');
      const team1 = yield* createTeam(nextGuildId(), owner1);
      const member1Id = yield* addTeamMember(team1.id, owner1);
      sessionsStore.set('team1-token', owner1);

      const owner2 = yield* createUser(nextDiscordId(), 'owner-x2');
      const team2 = yield* createTeam(nextGuildId(), owner2);
      const member2Id = yield* addTeamMember(team2.id, owner2);
      sessionsStore.set('team2-token', owner2);

      // Admin role for both, so every kind's gate is open.
      const adminRole1 = yield* createRoleWithPermissions(team1.id, 'Everything', [
        'team:manage',
        'group:manage',
        'member:view',
        'roster:view',
      ]);
      yield* assignRoleToMember(member1Id, adminRole1);
      const adminRole2 = yield* createRoleWithPermissions(team2.id, 'Everything', [
        'team:manage',
        'group:manage',
        'member:view',
        'roster:view',
      ]);
      yield* assignRoleToMember(member2Id, adminRole2);

      yield* createEvent(team1.id, 'Shared Name Event', member1Id);
      yield* createEvent(team2.id, 'Shared Name Event', member2Id);
      yield* createGroup(team1.id, 'Shared Name Group');
      yield* createGroup(team2.id, 'Shared Name Group');
      yield* createTrainingType(team1.id, 'Shared Name Training');
      yield* createTrainingType(team2.id, 'Shared Name Training');
      yield* createRoster(team1.id, 'Shared Name Roster');
      yield* createRoster(team2.id, 'Shared Name Roster');

      const response1 = yield* Effect.promise(() => search(team1.id, 'team1-token', 'Shared Name'));
      expect(response1.status).toBe(200);
      const body1 = (yield* Effect.promise(() => response1.json())) as ReadonlyArray<{
        kind: string;
        event?: { teamId: string };
        group?: { teamId: string };
        roster?: { teamId: string };
        trainingType?: { teamId: string };
      }>;
      expect(body1.length).toBeGreaterThan(0);
      for (const hit of body1) {
        const teamId =
          hit.event?.teamId ?? hit.group?.teamId ?? hit.roster?.teamId ?? hit.trainingType?.teamId;
        if (teamId !== undefined) expect(teamId).toBe(team1.id);
      }

      const response2 = yield* Effect.promise(() => search(team2.id, 'team2-token', 'Shared Name'));
      expect(response2.status).toBe(200);
      const body2 = (yield* Effect.promise(() => response2.json())) as ReadonlyArray<{
        kind: string;
        event?: { teamId: string };
        group?: { teamId: string };
        roster?: { teamId: string };
        trainingType?: { teamId: string };
      }>;
      expect(body2.length).toBeGreaterThan(0);
      for (const hit of body2) {
        const teamId =
          hit.event?.teamId ?? hit.group?.teamId ?? hit.roster?.teamId ?? hit.trainingType?.teamId;
        if (teamId !== undefined) expect(teamId).toBe(team2.id);
      }
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 4 — member:view but no roster:view, against real rows.
// ---------------------------------------------------------------------------

describe('search API — member:view without roster:view, real rows (4)', () => {
  it.effect('members are returned, rosters are not', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser(nextDiscordId(), 'owner-mv');
      const team = yield* createTeam(nextGuildId(), ownerId);

      const callerUserId = yield* createUser(nextDiscordId(), 'caller-mv');
      const callerMemberId = yield* addTeamMember(team.id, callerUserId);
      sessionsStore.set('member-view-only-token', callerUserId);

      const role = yield* createRoleWithPermissions(team.id, 'MemberViewOnly', ['member:view']);
      yield* assignRoleToMember(callerMemberId, role);

      // A distinctly named second member so `list_members` has a matching row.
      const targetUserId = yield* createUser(nextDiscordId(), 'target-mv');
      yield* addTeamMember(team.id, targetUserId);

      yield* createRoster(team.id, 'Gatekept Roster MV');

      const response = yield* Effect.promise(() => search(team.id, 'member-view-only-token', 'MV'));
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        kind: string;
      }>;
      expect(body.some((h) => h.kind === 'member')).toBe(true);
      expect(body.some((h) => h.kind === 'roster')).toBe(false);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 5 — team:manage does NOT see an event in a group they are not in (real-SQL counterpart of §F.3
// case 11 — the one that would catch a future `includeAllGroups: true` regression).
// ---------------------------------------------------------------------------

describe('search API — team:manage still respects the event group filter, real SQL (5)', () => {
  it.effect('an admin not in the event group does not see it, even with team:manage', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser(nextDiscordId(), 'owner-tm');
      const team = yield* createTeam(nextGuildId(), ownerId);

      const adminUserId = yield* createUser(nextDiscordId(), 'admin-tm');
      const adminMemberId = yield* addTeamMember(team.id, adminUserId);
      sessionsStore.set('team-manage-token', adminUserId);
      const adminRole = yield* createRoleWithPermissions(team.id, 'TeamManageOnly', [
        'team:manage',
      ]);
      yield* assignRoleToMember(adminMemberId, adminRole);

      const restrictedGroup = yield* createGroup(team.id, 'Restricted TM Group');
      yield* createEvent(
        team.id,
        'TM Restricted Event',
        adminMemberId,
        Option.some(restrictedGroup),
      );

      const response = yield* Effect.promise(() =>
        search(team.id, 'team-manage-token', 'TM Restricted'),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        kind: string;
      }>;
      expect(body.some((h) => h.kind === 'event')).toBe(false);
    }).pipe(Effect.provide(SeedLayer)),
  );
});
