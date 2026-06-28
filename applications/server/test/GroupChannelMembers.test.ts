/**
 * Tests for Channel/GetGroupMembers RPC handler (server side).
 *
 * The handler:
 *   - lives in `src/rpc/channel/index.ts` as `Channel/GetGroupMembers`,
 *   - looks up the group via findGroupById,
 *   - team-scopes: if group.team_id !== request team_id → return [],
 *     and if group not found → return [],
 *     in both cases does NOT call findDescendantMembersWithDiscordIdByGroupId,
 *   - calls findDescendantMembersWithDiscordIdByGroupId(group_id),
 *   - filters out entries where discordUserId is null,
 *   - returns ChannelRpcModels.GroupMemberDiscord[] with the surviving entries.
 *
 * Handler-level tests stub GroupsRepository. The descendant-aware SQL logic lives
 * in the repository query; the integration test suite
 * (test/integration/repositories/GroupsRepository.test.ts,
 * describe 'GroupsRepository — findDescendantMembersWithDiscordIdByGroupId')
 * covers the real DB traversal. Here we only assert handler contract: team-scoping,
 * null-filtering, and pass-through of descendant query results.
 */

import { it as itEffect } from '@effect/vitest';
import type { Discord, GroupModel, Team, TeamMember } from '@sideline/domain';
import { ChannelRpcGroup } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { beforeEach, describe, expect } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { ChannelsRpcLive } from '~/rpc/channel/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0005-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-0000-0005-000000000011' as Team.TeamId;
const GROUP_ID = '00000000-0000-0000-0005-000000000040' as GroupModel.GroupId;
const MEMBER_ID_A = '00000000-0000-0000-0005-000000000001' as TeamMember.TeamMemberId;
const MEMBER_ID_B = '00000000-0000-0000-0005-000000000002' as TeamMember.TeamMemberId;
const DISCORD_USER_A = '111111111111111112' as Discord.Snowflake;
const DISCORD_USER_B = '222222222222222223' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type GroupRowLike = {
  id: GroupModel.GroupId;
  team_id: Team.TeamId;
  parent_id: Option.Option<GroupModel.GroupId>;
  name: string;
  emoji: Option.Option<string>;
  color: Option.Option<string>;
};

type DescendantMemberRow = {
  teamMemberId: TeamMember.TeamMemberId;
  discordUserId: Discord.Snowflake | null;
};

// ---------------------------------------------------------------------------
// Spy stores (reset before each test)
// ---------------------------------------------------------------------------

let findGroupByIdCalls: GroupModel.GroupId[];
let findDescendantMembersWithDiscordIdCalls: GroupModel.GroupId[];

const resetSpies = () => {
  findGroupByIdCalls = [];
  findDescendantMembersWithDiscordIdCalls = [];
};

// ---------------------------------------------------------------------------
// Mock layer factories
// ---------------------------------------------------------------------------

const makeGroupsLayer = (opts: {
  group: Option.Option<GroupRowLike>;
  descendantMembers: DescendantMemberRow[];
}) =>
  Layer.succeed(GroupsRepository, {
    _tag: 'api/GroupsRepository',
    findGroupById: (id: GroupModel.GroupId) => {
      findGroupByIdCalls.push(id);
      return Effect.succeed(opts.group);
    },
    findDescendantMembersWithDiscordIdByGroupId: (id: GroupModel.GroupId) => {
      findDescendantMembersWithDiscordIdCalls.push(id);
      return Effect.succeed(opts.descendantMembers);
    },
    // Stub out everything else
    findGroupsByTeamId: () => Effect.succeed([]),
    insertGroup: () => Effect.die(new Error('Not implemented')),
    updateGroupById: () => Effect.die(new Error('Not implemented')),
    archiveGroupById: () => Effect.void,
    moveGroup: () => Effect.die(new Error('Not implemented')),
    findMembersByGroupId: () => Effect.succeed([]),
    addMemberById: () => Effect.void,
    removeMemberById: () => Effect.void,
    getRolesForGroup: () => Effect.succeed([]),
    getMemberCount: () => Effect.succeed(0),
    getChildren: () => Effect.succeed([]),
    getAncestorIds: () => Effect.succeed([]),
    getAncestors: () => Effect.succeed([]),
    getDescendantMemberIds: () => Effect.succeed([]),
    findMembersWithDiscordIdByGroupId: () => Effect.succeed([]),
  } as never);

const makeMinimalChannelSyncLayer = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: () => Effect.void,
    emitChannelDeleted: () => Effect.void,
    emitChannelArchived: () => Effect.void,
    emitChannelDetached: () => Effect.void,
    emitRosterChannelCreated: () => Effect.void,
    emitRosterChannelDeleted: () => Effect.void,
    emitRosterChannelArchived: () => Effect.void,
    emitRosterChannelDetached: () => Effect.void,
    emitGroupChannelUpdated: () => Effect.void,
    emitRosterChannelUpdated: () => Effect.void,
    emitMemberAdded: () => Effect.void,
    emitMemberRemoved: () => Effect.void,
    emitMembersAddedBatch: () => Effect.void,
    emitMembersRemovedBatch: () => Effect.void,
    emitRosterMemberAdded: () => Effect.void,
    emitRosterMemberRemoved: () => Effect.void,
    emitManagedChannelCreated: () => Effect.void,
    emitManagedChannelArchived: () => Effect.void,
    emitManagedChannelDeleted: () => Effect.void,
    emitManagedChannelRestored: () => Effect.void,
    emitManagedChannelAdopted: () => Effect.void,
    emitDiscordChannelArchived: () => Effect.void,
    emitDiscordChannelRestored: () => Effect.void,
    emitManagedAccessGrantedBatch: () => Effect.void,
    emitManagedAccessRevokedBatch: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    markPermanentlyFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as never);

const makeMinimalMappingLayer = () =>
  Layer.succeed(DiscordChannelMappingRepository, {
    _tag: 'api/DiscordChannelMappingRepository',
    findByGroupId: () => Effect.succeed(Option.none()),
    findByRosterId: () => Effect.succeed(Option.none()),
    insert: () => Effect.succeed(Option.none()),
    insertRoleOnly: () => Effect.succeed(Option.none()),
    upsertGroupChannel: () => Effect.void,
    clearGroupChannel: () => Effect.void,
    insertRoster: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    deleteByRosterId: () => Effect.void,
    findAllByTeam: () => Effect.succeed([]),
    findGroupsMissingRole: () => Effect.succeed([]),
    findClaimThread: () => Effect.succeed(Option.none()),
    saveClaimThreadIfAbsent: () => Effect.succeed(Option.none()),
    clearClaimThread: () => Effect.void,
  } as never);

const makeMinimalRostersLayer = () =>
  Layer.succeed(RostersRepository, {
    findByTeamId: () => Effect.succeed([]),
    findRosterById: () => Effect.succeed(Option.none()),
    insert: () => Effect.die(new Error('Not implemented')),
    update: () => Effect.die(new Error('Not implemented')),
    delete: () => Effect.void,
    findMemberEntriesById: () => Effect.succeed([]),
    addMemberById: () => Effect.void,
    removeMemberById: () => Effect.void,
  } as never);

const makeMinimalTeamSettingsLayer = () =>
  Layer.succeed(TeamSettingsRepository, {
    _tag: 'api/TeamSettingsRepository',
    findByTeam: () => Effect.succeed(Option.none()),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsertSettings: () => Effect.void,
    upsert: () => Effect.void,
    getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
    getHorizonDays: () => Effect.succeed(30),
  } as never);

const makeMinimalTeamChannelsLayer = () =>
  Layer.succeed(TeamChannelsRepository, {
    _tag: 'api/TeamChannelsRepository',
    findById: () => Effect.succeed(Option.none()),
    findAllByTeam: () => Effect.succeed([]),
    insert: () => Effect.die(new Error('Not implemented')),
    insertAdopted: () => Effect.die(new Error('Not implemented')),
    rename: () => Effect.die(new Error('Not implemented')),
    updateOrganization: () => Effect.die(new Error('Not implemented')),
    setArchived: () => Effect.void,
    delete: () => Effect.void,
    upsertDiscordChannelId: () => Effect.void,
    clearDiscordChannelId: () => Effect.void,
  } as never);

const makeMinimalTeamChannelAccessLayer = () =>
  Layer.succeed(TeamChannelAccessRepository, {
    _tag: 'api/TeamChannelAccessRepository',
    findByChannel: () => Effect.succeed([]),
    findByChannelForUpdate: () => Effect.succeed([]),
    findGrantsByGroup: () => Effect.succeed([]),
    upsertGrant: () => Effect.void,
    deleteGrant: () => Effect.void,
    countByChannel: () => Effect.succeed(0),
    findGroupRoleIds: () => Effect.succeed([]),
  } as never);

// ---------------------------------------------------------------------------
// TestLayer builder
// ---------------------------------------------------------------------------

const buildTestLayer = (groupsLayer: Layer.Layer<GroupsRepository>) =>
  ChannelsRpcLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        groupsLayer,
        makeMinimalMappingLayer(),
        makeMinimalChannelSyncLayer(),
        makeMinimalRostersLayer(),
        makeMinimalTeamSettingsLayer(),
        makeMinimalTeamChannelsLayer(),
        makeMinimalTeamChannelAccessLayer(),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Channel/GetGroupMembers handler', () => {
  beforeEach(resetSpies);

  /**
   * Test 1: team-scoped match
   *   group.team_id === request.team_id, repo returns 2 members, both with discord ids
   *   → 2 GroupMemberDiscord returned with correct ids
   */
  itEffect(
    'team-scoped match: group exists in TEAM_ID, 2 members with discord ids → 2 GroupMemberDiscord returned',
    () => {
      const group: GroupRowLike = {
        id: GROUP_ID,
        team_id: TEAM_ID,
        parent_id: Option.none(),
        name: 'Goalkeepers',
        emoji: Option.none(),
        color: Option.none(),
      };
      const descendantMembers: DescendantMemberRow[] = [
        { teamMemberId: MEMBER_ID_A, discordUserId: DISCORD_USER_A },
        { teamMemberId: MEMBER_ID_B, discordUserId: DISCORD_USER_B },
      ];

      const testLayer = buildTestLayer(
        makeGroupsLayer({ group: Option.some(group), descendantMembers }),
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('result', ({ client }) =>
          client['Channel/GetGroupMembers']({ team_id: TEAM_ID, group_id: GROUP_ID }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(result).toHaveLength(2);
            const memberA = result.find((m) => m.team_member_id === MEMBER_ID_A);
            const memberB = result.find((m) => m.team_member_id === MEMBER_ID_B);
            if (memberA === undefined || memberB === undefined) {
              throw new Error('Expected both members in result');
            }
            expect(memberA.discord_user_id).toBe(DISCORD_USER_A);
            expect(memberB.discord_user_id).toBe(DISCORD_USER_B);
            // findGroupById was called with the correct group id
            expect(findGroupByIdCalls).toHaveLength(1);
            expect(findGroupByIdCalls[0]).toBe(GROUP_ID);
            // descendant query was called
            expect(findDescendantMembersWithDiscordIdCalls).toHaveLength(1);
            expect(findDescendantMembersWithDiscordIdCalls[0]).toBe(GROUP_ID);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  /**
   * Test 2: null discord filtered
   *   repo returns 2 members: A has discord_user_id, B has null
   *   → only A returned (B filtered out)
   */
  itEffect(
    'null discord filtered: one member has null discord_user_id → only the member with a discord id is returned',
    () => {
      const group: GroupRowLike = {
        id: GROUP_ID,
        team_id: TEAM_ID,
        parent_id: Option.none(),
        name: 'Goalkeepers',
        emoji: Option.none(),
        color: Option.none(),
      };
      const descendantMembers: DescendantMemberRow[] = [
        { teamMemberId: MEMBER_ID_A, discordUserId: DISCORD_USER_A },
        { teamMemberId: MEMBER_ID_B, discordUserId: null },
      ];

      const testLayer = buildTestLayer(
        makeGroupsLayer({ group: Option.some(group), descendantMembers }),
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('result', ({ client }) =>
          client['Channel/GetGroupMembers']({ team_id: TEAM_ID, group_id: GROUP_ID }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            // Only member A (with a discord id) should be returned
            expect(result).toHaveLength(1);
            expect(result[0]?.team_member_id).toBe(MEMBER_ID_A);
            expect(result[0]?.discord_user_id).toBe(DISCORD_USER_A);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  /**
   * Test 3: descendant/subgroup members included
   *   The handler passes descendant members from the SQL query through unchanged.
   *   At handler level we assert: whatever findDescendantMembersWithDiscordIdByGroupId
   *   returns (even members not direct children), the handler passes them through.
   *   (The real descendant SQL logic is tested by the
   *   'GroupsRepository — findDescendantMembersWithDiscordIdByGroupId' integration tests
   *   in test/integration/repositories/GroupsRepository.test.ts.)
   */
  itEffect(
    'descendant/subgroup members included: handler passes through all rows from descendant query',
    () => {
      const group: GroupRowLike = {
        id: GROUP_ID,
        team_id: TEAM_ID,
        parent_id: Option.none(),
        name: 'Goalkeepers',
        emoji: Option.none(),
        color: Option.none(),
      };
      // Simulate repo returning members from both direct and descendant subgroups
      const MEMBER_ID_C = '00000000-0000-0000-0005-000000000003' as TeamMember.TeamMemberId;
      const DISCORD_USER_C = '333333333333333334' as Discord.Snowflake;
      const descendantMembers: DescendantMemberRow[] = [
        { teamMemberId: MEMBER_ID_A, discordUserId: DISCORD_USER_A },
        { teamMemberId: MEMBER_ID_B, discordUserId: DISCORD_USER_B },
        { teamMemberId: MEMBER_ID_C, discordUserId: DISCORD_USER_C },
      ];

      const testLayer = buildTestLayer(
        makeGroupsLayer({ group: Option.some(group), descendantMembers }),
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('result', ({ client }) =>
          client['Channel/GetGroupMembers']({ team_id: TEAM_ID, group_id: GROUP_ID }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            // All 3 members (including "descendant" C) must pass through
            expect(result).toHaveLength(3);
            const ids = result.map((m) => m.team_member_id);
            expect(ids).toContain(MEMBER_ID_A);
            expect(ids).toContain(MEMBER_ID_B);
            expect(ids).toContain(MEMBER_ID_C);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  /**
   * Test 4: cross-team scoping
   *   group.team_id = OTHER_TEAM_ID, request.team_id = TEAM_ID
   *   → empty array returned
   *   → findDescendantMembersWithDiscordIdByGroupId NOT called
   */
  itEffect(
    'cross-team scoping: group belongs to OTHER_TEAM_ID, request uses TEAM_ID → empty array, descendant query NOT called',
    () => {
      const group: GroupRowLike = {
        id: GROUP_ID,
        team_id: OTHER_TEAM_ID, // belongs to a different team
        parent_id: Option.none(),
        name: 'Goalkeepers',
        emoji: Option.none(),
        color: Option.none(),
      };

      const testLayer = buildTestLayer(
        makeGroupsLayer({
          group: Option.some(group),
          descendantMembers: [{ teamMemberId: MEMBER_ID_A, discordUserId: DISCORD_USER_A }],
        }),
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('result', ({ client }) =>
          // Request with TEAM_ID, but group is in OTHER_TEAM_ID → team mismatch
          client['Channel/GetGroupMembers']({ team_id: TEAM_ID, group_id: GROUP_ID }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            // Must return empty array — cross-team access denied
            expect(result).toHaveLength(0);
            // The descendant query must NOT have been called — short-circuit on team mismatch
            expect(findDescendantMembersWithDiscordIdCalls).toHaveLength(0);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  /**
   * Test 5: group not found
   *   findGroupById → None → empty array
   *   → findDescendantMembersWithDiscordIdByGroupId NOT called
   */
  itEffect(
    'group not found: findGroupById returns None → empty array, descendant query NOT called',
    () => {
      const testLayer = buildTestLayer(
        makeGroupsLayer({
          group: Option.none(), // group not found
          descendantMembers: [],
        }),
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('result', ({ client }) =>
          client['Channel/GetGroupMembers']({ team_id: TEAM_ID, group_id: GROUP_ID }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            // Must return empty array
            expect(result).toHaveLength(0);
            // findGroupById was called
            expect(findGroupByIdCalls).toHaveLength(1);
            // findDescendantMembersWithDiscordIdByGroupId must NOT have been called
            expect(findDescendantMembersWithDiscordIdCalls).toHaveLength(0);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  /**
   * Test 6: all members have null discord id → empty array after filtering
   */
  itEffect('all members have null discord ids → empty array after filtering', () => {
    const group: GroupRowLike = {
      id: GROUP_ID,
      team_id: TEAM_ID,
      parent_id: Option.none(),
      name: 'Goalkeepers',
      emoji: Option.none(),
      color: Option.none(),
    };
    const descendantMembers: DescendantMemberRow[] = [
      { teamMemberId: MEMBER_ID_A, discordUserId: null },
      { teamMemberId: MEMBER_ID_B, discordUserId: null },
    ];

    const testLayer = buildTestLayer(
      makeGroupsLayer({ group: Option.some(group), descendantMembers }),
    );

    return Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
      Effect.bind('result', ({ client }) =>
        client['Channel/GetGroupMembers']({ team_id: TEAM_ID, group_id: GROUP_ID }),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result).toHaveLength(0);
          // descendant query was still called
          expect(findDescendantMembersWithDiscordIdCalls).toHaveLength(1);
        }),
      ),
      Effect.provide(testLayer),
    );
  });
});
