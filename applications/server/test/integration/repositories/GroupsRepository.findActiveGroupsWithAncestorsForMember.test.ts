// TDD mode — bug fix-group-channel-discord-join (PR 1), Task 1.1.
//
// `GroupsRepository.findActiveGroupsWithAncestorsForMember(memberId, teamId)` is the read that
// drives `emitMemberGroupChannelRoles`: the member's non-archived `group_members` groups PLUS
// every active ancestor, with `tm.active = true` on the seed (a PK join, no row multiplication)
// and a `depth < 32` cycle guard identical in shape to `getActiveAncestors`
// (`GroupsRepository.ts:275-295`, see that query's header for why the severing semantics here
// MUST agree with `effectiveRoles.ts`'s ancestor walk — role sync and channel sync must never
// disagree about which ancestors still grant).
//
// This file is expected to FAIL to type-check and to fail at runtime until Task 1.1 adds the
// method — that is the point of TDD mode. Do NOT stub around the missing method; the failure IS
// the signal that Task 1.1 has not landed yet.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  GroupsRepository.Default,
  RolesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers — same shape as `GroupsRepository.test.ts` / `middleGroupArchivedChain.test.ts`.
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

const addActiveMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const deactivateMember = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.deactivateMemberByIds(teamId, memberId)),
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

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

const addGroupMember = (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.addMemberById(groupId, memberId)));

// Bypasses the API-layer cycle guard (`api/group.ts`'s `moveGroup` handler — NOT enforced by
// `GroupsRepository.moveGroup` itself) to write a `parent_id` cycle directly. No API path
// produces one any more — the guard runs in the same transaction as the `UPDATE` under a
// per-team advisory lock — but rows predating that fix, or written by hand, still can be
// cyclic, and every recursive walk must survive them.
const wireParentDirectly = (groupId: GroupModel.GroupId, parentId: GroupModel.GroupId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) => sql`UPDATE groups SET parent_id = ${parentId} WHERE id = ${groupId}`),
  );

const findActiveGroupsWithAncestors = (memberId: TeamMember.TeamMemberId, teamId: Team.TeamId) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findActiveGroupsWithAncestorsForMember(memberId, teamId)),
  );

const createRole = (teamId: Team.TeamId, name: string) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.insertRole(teamId, name)));

const assignRoleToGroup = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRoleToGroup(roleId, groupId)),
  );

const findEffectiveRoleIds = (memberId: TeamMember.TeamMemberId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEffectiveRoleIdsForMember(memberId)),
  );

describe('GroupsRepository — findActiveGroupsWithAncestorsForMember (TDD: bug fix-group-channel-discord-join, Task 1.1)', () => {
  it.effect('returns empty for a member with no groups at all', () =>
    Effect.Do.pipe(
      Effect.bind('owner', () => createUser('900200000000000001', 'owner-empty')),
      Effect.bind('team', ({ owner }) =>
        createTeam('910200000000000001' as Discord.Snowflake, owner.id),
      ),
      Effect.bind('memberUser', () => createUser('920200000000000001', 'member-empty')),
      Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
      Effect.bind('result', ({ member, team }) =>
        findActiveGroupsWithAncestors(member.id, team.id),
      ),
      Effect.tap(({ result }) => Effect.sync(() => expect(result).toHaveLength(0))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("excludes the member's own group when it is archived (archived seed)", () =>
    Effect.Do.pipe(
      Effect.bind('owner', () => createUser('900200000000000002', 'owner-archived-seed')),
      Effect.bind('team', ({ owner }) =>
        createTeam('910200000000000002' as Discord.Snowflake, owner.id),
      ),
      Effect.bind('memberUser', () => createUser('920200000000000002', 'member-archived-seed')),
      Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
      Effect.bind('group', ({ team }) => createGroup(team.id, 'Archived Own Group')),
      Effect.tap(({ group, member }) => addGroupMember(group.id, member.id)),
      Effect.tap(({ group }) => archiveGroup(group.id)),
      Effect.bind('result', ({ member, team }) =>
        findActiveGroupsWithAncestors(member.id, team.id),
      ),
      Effect.tap(({ result }) => Effect.sync(() => expect(result).toHaveLength(0))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'an archived MIDDLE ancestor severs the walk — only the leaf group is returned, matching effectiveRoles.ts severing semantics',
    () =>
      Effect.Do.pipe(
        Effect.bind('owner', () => createUser('900200000000000003', 'owner-middle-severs')),
        Effect.bind('team', ({ owner }) =>
          createTeam('910200000000000003' as Discord.Snowflake, owner.id),
        ),
        Effect.bind('memberUser', () => createUser('920200000000000003', 'member-middle-severs')),
        Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
        Effect.bind('top', ({ team }) => createGroup(team.id, 'C (top)')),
        Effect.bind('middle', ({ team, top }) =>
          createGroup(team.id, 'B (middle, archived)', Option.some(top.id)),
        ),
        Effect.tap(({ middle }) => archiveGroup(middle.id)),
        Effect.bind('leaf', ({ team, middle }) =>
          createGroup(team.id, 'A (leaf)', Option.some(middle.id)),
        ),
        Effect.tap(({ leaf, member }) => addGroupMember(leaf.id, member.id)),
        Effect.bind('result', ({ member, team }) =>
          findActiveGroupsWithAncestors(member.id, team.id),
        ),
        Effect.tap(({ result, leaf, middle, top }) =>
          Effect.sync(() => {
            const ids = result.map((r) => r.id);
            expect(ids).toEqual([leaf.id]);
            expect(ids).not.toContain(middle.id);
            expect(ids).not.toContain(top.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // The ONLY level at which `tm.active = true` is observable: `reactivateMember` runs in
  // `registerMemberWithReconcile` (`rpc/guild/index.ts:495-497`) BEFORE `observeGuildMembership`
  // is bound (`:516-518`), so at the point this query would run in production the member is
  // always already active again. An RPC-level test can never exercise this guard — only a direct
  // repository call with a `group_members` row belonging to a member who is CURRENTLY inactive
  // can.
  it.effect('a group_members row for a currently-INACTIVE team_members row yields zero rows', () =>
    Effect.Do.pipe(
      Effect.bind('owner', () => createUser('900200000000000004', 'owner-inactive')),
      Effect.bind('team', ({ owner }) =>
        createTeam('910200000000000004' as Discord.Snowflake, owner.id),
      ),
      Effect.bind('memberUser', () => createUser('920200000000000004', 'member-inactive')),
      Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
      Effect.bind('group', ({ team }) => createGroup(team.id, 'Group For Inactive Member')),
      Effect.tap(({ group, member }) => addGroupMember(group.id, member.id)),
      Effect.tap(({ team, member }) => deactivateMember(team.id, member.id)),
      Effect.bind('result', ({ member, team }) =>
        findActiveGroupsWithAncestors(member.id, team.id),
      ),
      Effect.tap(({ result }) => Effect.sync(() => expect(result).toHaveLength(0))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'a directly-written parent_id cycle terminates (depth < 32 guard) instead of hanging',
    () =>
      Effect.Do.pipe(
        Effect.bind('owner', () => createUser('900200000000000005', 'owner-cycle')),
        Effect.bind('team', ({ owner }) =>
          createTeam('910200000000000005' as Discord.Snowflake, owner.id),
        ),
        Effect.bind('memberUser', () => createUser('920200000000000005', 'member-cycle')),
        Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Cycle A')),
        Effect.bind('groupB', ({ team }) => createGroup(team.id, 'Cycle B')),
        // A -> B -> A, written directly (bypasses the API-layer guard).
        Effect.tap(({ groupA, groupB }) => wireParentDirectly(groupA.id, groupB.id)),
        Effect.tap(({ groupA, groupB }) => wireParentDirectly(groupB.id, groupA.id)),
        Effect.tap(({ groupA, member }) => addGroupMember(groupA.id, member.id)),
        Effect.bind('result', ({ member, team }) =>
          findActiveGroupsWithAncestors(member.id, team.id),
        ),
        Effect.tap(({ result, groupA, groupB }) =>
          Effect.sync(() => {
            // Terminates (the assertion running at all, inside the suite's normal timeout, IS
            // the cycle-guard proof) and — because of the final `DISTINCT` — reports each group
            // in the cycle exactly once, not once per lap around it.
            const ids = result.map((r) => r.id).sort();
            expect(ids).toEqual([groupA.id, groupB.id].sort());
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "cross-team isolation — a member's groups in their own team never leak into a query for a different team, even though the member row itself matches",
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerOne', () => createUser('900200000000000006', 'owner-cross-one')),
        Effect.bind('ownerTwo', () => createUser('900200000000000007', 'owner-cross-two')),
        Effect.bind('teamOne', ({ ownerOne }) =>
          createTeam('910200000000000006' as Discord.Snowflake, ownerOne.id),
        ),
        Effect.bind('teamTwo', ({ ownerTwo }) =>
          createTeam('910200000000000007' as Discord.Snowflake, ownerTwo.id),
        ),
        Effect.bind('memberUser', () => createUser('920200000000000006', 'member-cross')),
        Effect.bind('memberOne', ({ teamOne, memberUser }) =>
          addActiveMember(teamOne.id, memberUser.id),
        ),
        Effect.bind('groupOne', ({ teamOne }) => createGroup(teamOne.id, 'Team One Group')),
        Effect.tap(({ groupOne, memberOne }) => addGroupMember(groupOne.id, memberOne.id)),
        Effect.bind('groupTwo', ({ teamTwo }) => createGroup(teamTwo.id, 'Team Two Group')),
        Effect.bind('resultOwnTeam', ({ memberOne, teamOne }) =>
          findActiveGroupsWithAncestors(memberOne.id, teamOne.id),
        ),
        // Same member id, but the WRONG team — the group is scoped to teamOne, so this must not
        // see it, even though `group_members.team_member_id` matches.
        Effect.bind('resultWrongTeam', ({ memberOne, teamTwo }) =>
          findActiveGroupsWithAncestors(memberOne.id, teamTwo.id),
        ),
        Effect.tap(({ resultOwnTeam, resultWrongTeam, groupOne, groupTwo }) =>
          Effect.sync(() => {
            expect(resultOwnTeam.map((r) => r.id)).toEqual([groupOne.id]);
            expect(resultOwnTeam.some((r) => r.id === groupTwo.id)).toBe(false);
            expect(resultWrongTeam).toHaveLength(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Test 1 (tester review, PR 1 gap-fill): pins that this walk agrees with the SEPARATE walk in
  // `repositories/effectiveRoles.ts`. The archived-middle-severs test above only asserts this
  // query's OWN output — it never touches `findEffectiveRoleIdsForMember`, so it stays green even
  // if the two walks drift apart. `GroupsRepository.ts`'s header on
  // `findActiveGroupsWithAncestorsForMemberQuery` and `applications/server/AGENTS.md`'s
  // cross-reference rule both exist precisely because that drift is how a previous
  // "group roles invisible on the roster" bug shipped (see `effectiveRoles.ts`'s header).
  //
  // Fixture: G (leaf, member's own group) -> P (archived, middle) -> GP (top), with a distinct
  // role assigned to EACH group via `role_groups`. Because each role is assigned to exactly one
  // group, the set of role ids `findEffectiveRoleIdsForMember` returns can be mapped back
  // one-to-one to the groups that granted them — that inferred group set is asserted to equal
  // exactly the group set `findActiveGroupsWithAncestorsForMember` returns. Archiving P must
  // sever both walks identically: only G's own role/group survives, P's and GP's do not.
  it.effect(
    'the returned group set matches exactly the groups effectiveRoles.ts (findEffectiveRoleIdsForMember) grants roles through',
    () =>
      Effect.Do.pipe(
        Effect.bind('owner', () => createUser('900200000000000009', 'owner-agree-effective')),
        Effect.bind('team', ({ owner }) =>
          createTeam('910200000000000009' as Discord.Snowflake, owner.id),
        ),
        Effect.bind('memberUser', () => createUser('920200000000000009', 'member-agree-effective')),
        Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
        Effect.bind('groupTop', ({ team }) => createGroup(team.id, 'GP (top)')),
        Effect.bind('groupParent', ({ team, groupTop }) =>
          createGroup(team.id, 'P (archived middle)', Option.some(groupTop.id)),
        ),
        Effect.tap(({ groupParent }) => archiveGroup(groupParent.id)),
        Effect.bind('groupLeaf', ({ team, groupParent }) =>
          createGroup(team.id, 'G (leaf, member)', Option.some(groupParent.id)),
        ),
        Effect.tap(({ groupLeaf, member }) => addGroupMember(groupLeaf.id, member.id)),
        // One role per group, in a bijection, so "which roles are effectively held" can be
        // mapped straight back to "which groups granted them".
        Effect.bind('roleLeaf', ({ team }) => createRole(team.id, 'Role of G')),
        Effect.bind('roleParent', ({ team }) => createRole(team.id, 'Role of P')),
        Effect.bind('roleTop', ({ team }) => createRole(team.id, 'Role of GP')),
        Effect.tap(({ roleLeaf, groupLeaf }) => assignRoleToGroup(roleLeaf.id, groupLeaf.id)),
        Effect.tap(({ roleParent, groupParent }) =>
          assignRoleToGroup(roleParent.id, groupParent.id),
        ),
        Effect.tap(({ roleTop, groupTop }) => assignRoleToGroup(roleTop.id, groupTop.id)),
        Effect.bind('walkResult', ({ member, team }) =>
          findActiveGroupsWithAncestors(member.id, team.id),
        ),
        Effect.bind('effectiveRoles', ({ member }) => findEffectiveRoleIds(member.id)),
        Effect.tap(
          ({
            walkResult,
            effectiveRoles,
            groupLeaf,
            groupParent,
            groupTop,
            roleLeaf,
            roleParent,
            roleTop,
          }) =>
            Effect.sync(() => {
              const roleToGroup = new Map([
                [roleLeaf.id, groupLeaf.id],
                [roleParent.id, groupParent.id],
                [roleTop.id, groupTop.id],
              ]);
              const effectiveRoleIds = new Set(effectiveRoles.map((r) => r.role_id));
              const groupsGrantingViaEffectiveRoles = new Set(
                [...roleToGroup.entries()]
                  .filter(([roleId]) => effectiveRoleIds.has(roleId))
                  .map(([, groupId]) => groupId),
              );
              const groupsFromWalk = new Set(walkResult.map((r) => r.id));

              expect(groupsFromWalk).toEqual(groupsGrantingViaEffectiveRoles);
              // Pin the concrete expectation too, not just "the two walks agree with each
              // other" — both walks are asserted to agree AND to be the archived-severs-the-
              // rest set, so a bug that changes both walks identically (e.g. dropping the
              // `is_archived` filter from both) would still be caught.
              expect(groupsFromWalk).toEqual(new Set([groupLeaf.id]));
            }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Test 2 (tester review, PR 1 gap-fill): pins the TRUNCATION DEPTH, not just termination. The
  // cycle test above proves the walk terminates on a corrupted chain; it says nothing about
  // which ancestors survive on a long but ACYCLIC chain, so a future edit moving the `depth < 32`
  // guard onto the seed row instead of the recursive term, or loosening `<` to `<=`, would change
  // how many ancestors grant while every existing test stays green.
  //
  // Expected count derived empirically against the real query shape (seed = member's own group
  // at depth 0, recursive term gated by `WHERE r.depth < 32`): a row at depth 31 is allowed to
  // recurse (31 < 32) and produce a row at depth 32; a row AT depth 32 is NOT allowed to recurse
  // (32 < 32 is false), so depths 0..32 inclusive survive — 33 groups — regardless of how much
  // deeper the real chain goes. A 35-group chain (leaf + 34 ancestors, i.e. depths 0..34) was
  // used to confirm this against the actual CTE (`groups`/`group_members`/`team_members` schema)
  // before writing this test: exactly 33 rows come back, depths 0..32, and the two farthest
  // ancestors (depths 33 and 34) are the ones dropped.
  it.effect(
    'a 35-deep acyclic ancestor chain truncates at exactly 33 groups (depths 0..32) — the two farthest ancestors are dropped',
    () =>
      Effect.Do.pipe(
        Effect.bind('owner', () => createUser('900200000000000010', 'owner-deep-chain')),
        Effect.bind('team', ({ owner }) =>
          createTeam('910200000000000010' as Discord.Snowflake, owner.id),
        ),
        Effect.bind('memberUser', () => createUser('920200000000000010', 'member-deep-chain')),
        Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
        // Build a 35-group chain TOP-DOWN (a group's parent must already exist), then reverse so
        // `chainLeafToRoot[0]` is the member's own (leaf, depth 0) group and
        // `chainLeafToRoot[34]` is the farthest (depth 34) ancestor.
        Effect.bind('chainLeafToRoot', ({ team }) =>
          Effect.gen(function* () {
            const ids: Array<GroupModel.GroupId> = [];
            for (let i = 34; i >= 0; i--) {
              const parentId = ids.length > 0 ? Option.some(ids[ids.length - 1]!) : Option.none();
              const group = yield* createGroup(
                team.id,
                `Depth ${String(i).padStart(2, '0')}`,
                parentId,
              );
              ids.push(group.id);
            }
            return ids.reverse();
          }),
        ),
        Effect.tap(({ chainLeafToRoot, member }) => addGroupMember(chainLeafToRoot[0]!, member.id)),
        Effect.bind('result', ({ member, team }) =>
          findActiveGroupsWithAncestors(member.id, team.id),
        ),
        Effect.tap(({ result, chainLeafToRoot }) =>
          Effect.sync(() => {
            expect(result).toHaveLength(33);
            const returnedIds = new Set(result.map((r) => r.id));
            // The 33 nearest survive: depths 0..32, i.e. chain indices 0..32.
            for (let depth = 0; depth <= 32; depth++) {
              expect(returnedIds.has(chainLeafToRoot[depth]!)).toBe(true);
            }
            // The two farthest ancestors (depths 33 and 34) are permanently truncated.
            expect(returnedIds.has(chainLeafToRoot[33]!)).toBe(false);
            expect(returnedIds.has(chainLeafToRoot[34]!)).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Test 3 (tester review, PR 1 gap-fill): pins the NEW deterministic nearest-first ordering
  // (`ORDER BY min(depth), name, id`, replacing the old arbitrary `SELECT DISTINCT`). Ordering
  // matters here in a way it doesn't for most queries: `emitMemberGroupChannelRoles` slices this
  // result to `MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER` and, unlike the role diff, this only ever
  // runs once per join — whatever falls past the cap is lost forever, not merely deferred. An
  // arbitrary order would make WHICH groups get permanently lost nondeterministic.
  //
  // Fixture: the member belongs directly to two groups at depth 0 ("Alpha" and "Zulu" — chosen
  // to be alphabetically first/last so a wrong ordering is obvious). "Zulu"'s parent is "Kilo"
  // and "Alpha"'s parent is "Mike" (both depth 1); "Mike"'s parent is "November" (depth 2, the
  // farthest). Expected order: depth ascending first, then name ascending within a depth —
  // [Alpha, Zulu, Kilo, Mike, November]. (Group names are unique per team — see
  // `idx_subgroups_team_name`/the `GroupNameAlreadyTakenError` catch in
  // `GroupsRepository.insertGroup` — so two groups can never tie on BOTH depth and name within
  // one team, which is why `id` as a final tiebreaker cannot be exercised by a same-team
  // fixture; `name` ordering is the only tiebreaker this test can observe.)
  it.effect('returns groups in deterministic nearest-first order (min depth, then name)', () =>
    Effect.Do.pipe(
      Effect.bind('owner', () => createUser('900200000000000011', 'owner-ordering')),
      Effect.bind('team', ({ owner }) =>
        createTeam('910200000000000011' as Discord.Snowflake, owner.id),
      ),
      Effect.bind('memberUser', () => createUser('920200000000000011', 'member-ordering')),
      Effect.bind('member', ({ team, memberUser }) => addActiveMember(team.id, memberUser.id)),
      Effect.bind('november', ({ team }) => createGroup(team.id, 'November')),
      Effect.bind('mike', ({ team, november }) =>
        createGroup(team.id, 'Mike', Option.some(november.id)),
      ),
      Effect.bind('kilo', ({ team }) => createGroup(team.id, 'Kilo')),
      Effect.bind('alpha', ({ team, mike }) => createGroup(team.id, 'Alpha', Option.some(mike.id))),
      Effect.bind('zulu', ({ team, kilo }) => createGroup(team.id, 'Zulu', Option.some(kilo.id))),
      Effect.tap(({ alpha, member }) => addGroupMember(alpha.id, member.id)),
      Effect.tap(({ zulu, member }) => addGroupMember(zulu.id, member.id)),
      Effect.bind('result', ({ member, team }) =>
        findActiveGroupsWithAncestors(member.id, team.id),
      ),
      Effect.tap(({ result, alpha, zulu, kilo, mike, november }) =>
        Effect.sync(() => {
          expect(result.map((r) => r.id)).toEqual([
            alpha.id,
            zulu.id,
            kilo.id,
            mike.id,
            november.id,
          ]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
