/**
 * Tests for Task 3a — Grant reapply on none→Some role transition
 * and Task 3b — Channel/BackfillMissingGroupRoles RPC handler.
 *
 * These tests drive the REAL handlers via RpcTest.makeClient, not stubs.
 */

import { it as itEffect } from '@effect/vitest';
import type { Discord, GroupModel, Team, TeamChannel, TeamChannelAccess } from '@sideline/domain';
import { ChannelRpcGroup } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { beforeEach, describe, expect } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import type { GroupMissingRoleRow } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { ChannelsRpcLive } from '~/rpc/channel/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0003-000000000010' as Team.TeamId;
const GROUP_A = '00000000-0000-0000-0003-000000000040' as GroupModel.GroupId;
const GROUP_B = '00000000-0000-0000-0003-000000000041' as GroupModel.GroupId;
const CHANNEL_1 = '00000000-0000-0000-0003-000000000030' as TeamChannel.TeamChannelId;
const CHANNEL_2 = '00000000-0000-0000-0003-000000000031' as TeamChannel.TeamChannelId;
const DISCORD_CHANNEL_1 = '111111111111111111' as Discord.Snowflake;
const NEW_ROLE_A = '222222222222222222' as Discord.Snowflake;
const OLD_ROLE_A = '333333333333333333' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Spy stores (reset before each test)
// ---------------------------------------------------------------------------

let grantedBatchCalls: Array<{ teamId: Team.TeamId; entries: unknown[] }>;
let channelCreatedCalls: Array<{
  teamId: Team.TeamId;
  groupId: GroupModel.GroupId;
  groupName: string;
  existingChannelId: Option.Option<Discord.Snowflake>;
  discordChannelName?: string;
  discordRoleName?: string;
  discordRoleColor?: Option.Option<number>;
}>;

const resetSpies = () => {
  grantedBatchCalls = [];
  channelCreatedCalls = [];
};

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type AccessEntry = {
  group_id: GroupModel.GroupId;
  access_level: TeamChannelAccess.AccessLevel;
  team_channel_id: TeamChannel.TeamChannelId;
};

type ChannelEntry = {
  id: TeamChannel.TeamChannelId;
  team_id: Team.TeamId;
  discord_channel_id: Option.Option<Discord.Snowflake>;
};

// ---------------------------------------------------------------------------
// Mock layer factories
// ---------------------------------------------------------------------------

const makeMappingLayer = (opts: {
  insertReturnsOldRole: Option.Option<Discord.Snowflake>;
  insertRoleOnlyReturnsOldRole: Option.Option<Discord.Snowflake>;
  missingGroups?: GroupMissingRoleRow[];
}) =>
  Layer.succeed(DiscordChannelMappingRepository, {
    _tag: 'api/DiscordChannelMappingRepository',
    findByGroupId: () => Effect.succeed(Option.none()),
    findByRosterId: () => Effect.succeed(Option.none()),
    insert: () => Effect.succeed(opts.insertReturnsOldRole),
    insertRoleOnly: () => Effect.succeed(opts.insertRoleOnlyReturnsOldRole),
    upsertGroupChannel: () => Effect.void,
    clearGroupChannel: () => Effect.void,
    insertRoster: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    deleteByRosterId: () => Effect.void,
    findAllByTeam: () => Effect.succeed([]),
    findGroupsMissingRole: () => Effect.succeed(opts.missingGroups ?? []),
    findClaimThread: () => Effect.succeed(Option.none()),
    saveClaimThreadIfAbsent: () => Effect.succeed(Option.none()),
    clearClaimThread: () => Effect.void,
  } as never);

const makeAccessLayer = (grants: AccessEntry[]) =>
  Layer.succeed(TeamChannelAccessRepository, {
    _tag: 'api/TeamChannelAccessRepository',
    findByChannel: (channelId: TeamChannel.TeamChannelId) =>
      Effect.succeed(
        grants
          .filter((g) => g.team_channel_id === channelId)
          .map((g) => ({ group_id: g.group_id, access_level: g.access_level })),
      ),
    findByChannelForUpdate: (channelId: TeamChannel.TeamChannelId) =>
      Effect.succeed(
        grants
          .filter((g) => g.team_channel_id === channelId)
          .map((g) => ({ group_id: g.group_id, access_level: g.access_level })),
      ),
    findGrantsByGroup: (groupId: GroupModel.GroupId) =>
      Effect.succeed(
        grants
          .filter((g) => g.group_id === groupId)
          .map((g) => ({ team_channel_id: g.team_channel_id, access_level: g.access_level })),
      ),
    upsertGrant: () => Effect.void,
    deleteGrant: () => Effect.void,
    countByChannel: () => Effect.succeed(0),
    findGroupRoleIds: (groupIds: readonly GroupModel.GroupId[]) =>
      Effect.succeed(
        groupIds.map((id) => ({
          group_id: id,
          discord_role_id: Option.some(NEW_ROLE_A),
        })),
      ),
  } as never);

const makeChannelsLayer = (channels: ChannelEntry[]) =>
  Layer.succeed(TeamChannelsRepository, {
    _tag: 'api/TeamChannelsRepository',
    findById: (id: TeamChannel.TeamChannelId) => {
      const ch = channels.find((c) => c.id === id);
      return Effect.succeed(ch ? Option.some(ch) : Option.none());
    },
    findAllByTeam: () => Effect.succeed(channels),
    insert: () => Effect.die(new Error('Not implemented')),
    insertAdopted: () => Effect.die(new Error('Not implemented')),
    rename: () => Effect.die(new Error('Not implemented')),
    updateOrganization: () => Effect.die(new Error('Not implemented')),
    setArchived: () => Effect.void,
    delete: () => Effect.void,
    upsertDiscordChannelId: () => Effect.void,
    clearDiscordChannelId: () => Effect.void,
  } as never);

const makeChannelSyncLayer = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      groupName: string,
      existingChannelId: Option.Option<Discord.Snowflake>,
      discordChannelName?: string,
      discordRoleName?: string,
      discordRoleColor?: Option.Option<number>,
    ) => {
      channelCreatedCalls.push({
        teamId,
        groupId,
        groupName,
        existingChannelId,
        ...(discordChannelName !== undefined ? { discordChannelName } : {}),
        ...(discordRoleName !== undefined ? { discordRoleName } : {}),
        ...(discordRoleColor !== undefined ? { discordRoleColor } : {}),
      });
      return Effect.void;
    },
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
    emitManagedChannelCreated: () => Effect.void,
    emitManagedChannelArchived: () => Effect.void,
    emitManagedChannelDeleted: () => Effect.void,
    emitManagedChannelRestored: () => Effect.void,
    emitManagedChannelAdopted: () => Effect.void,
    emitDiscordChannelArchived: () => Effect.void,
    emitDiscordChannelRestored: () => Effect.void,
    emitManagedAccessGrantedBatch: (args: { teamId: Team.TeamId; entries: unknown[] }) => {
      // Record ALL calls (no entries.length > 0 guard) so wrong-emit is catchable
      grantedBatchCalls.push({ teamId: args.teamId, entries: args.entries });
      return Effect.void;
    },
    emitManagedAccessRevokedBatch: () => Effect.void,
    emitMembersAddedBatch: () => Effect.void,
    emitMembersRemovedBatch: () => Effect.void,
    emitRosterMemberAdded: () => Effect.void,
    emitRosterMemberRemoved: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    markPermanentlyFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as never);

const makeTeamSettingsLayer = (createDiscordChannelOnGroup: boolean) =>
  Layer.succeed(TeamSettingsRepository, {
    _tag: 'api/TeamSettingsRepository',
    findByTeam: () => Effect.succeed(Option.none()),
    findByTeamId: (id: Team.TeamId) =>
      id === TEAM_ID
        ? Effect.succeed(
            Option.some({
              create_discord_channel_on_group: createDiscordChannelOnGroup,
              discord_channel_format: null,
              discord_role_format: null,
              discord_archive_category_id: Option.none(),
              event_horizon_days: 30,
            } as never),
          )
        : Effect.succeed(Option.none()),
    upsertSettings: () => Effect.void,
    upsert: () => Effect.void,
    getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
    getHorizonDays: () => Effect.succeed(30),
  } as never);

const makeRostersLayer = () =>
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

// ---------------------------------------------------------------------------
// TestLayer builder
// ---------------------------------------------------------------------------

const buildTestLayer = (
  grants: AccessEntry[],
  channels: ChannelEntry[],
  mappingOpts: {
    insertReturnsOldRole: Option.Option<Discord.Snowflake>;
    insertRoleOnlyReturnsOldRole: Option.Option<Discord.Snowflake>;
    missingGroups?: GroupMissingRoleRow[];
  },
  createDiscordChannelOnGroup = false,
) =>
  ChannelsRpcLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeMappingLayer(mappingOpts),
        makeAccessLayer(grants),
        makeChannelsLayer(channels),
        makeChannelSyncLayer(),
        makeTeamSettingsLayer(createDiscordChannelOnGroup),
        makeRostersLayer(),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Task 3a tests — UpsertMappingRoleOnly
// ---------------------------------------------------------------------------

describe('Task 3a — grant reapply on none→Some role transition (UpsertMappingRoleOnly)', () => {
  beforeEach(resetSpies);

  itEffect(
    'none→Some: group has a grant on provisioned channel → emitManagedAccessGrantedBatch called with entry',
    () => {
      const grants: AccessEntry[] = [
        { group_id: GROUP_A, access_level: 'VIEW', team_channel_id: CHANNEL_1 },
      ];
      const channels: ChannelEntry[] = [
        { id: CHANNEL_1, team_id: TEAM_ID, discord_channel_id: Option.some(DISCORD_CHANNEL_1) },
      ];

      const testLayer = buildTestLayer(grants, channels, {
        insertReturnsOldRole: Option.none(),
        insertRoleOnlyReturnsOldRole: Option.none(), // none→Some transition
      });

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.tap(({ client }) =>
          client['Channel/UpsertMappingRoleOnly']({
            team_id: TEAM_ID,
            group_id: GROUP_A,
            discord_role_id: NEW_ROLE_A,
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            // The none→Some transition must have triggered reapplyGroupGrants
            // grantedBatchCalls now records ALL calls (including empty-entries batches)
            const nonEmptyBatches = grantedBatchCalls.filter((c) => c.entries.length > 0);
            expect(nonEmptyBatches).toHaveLength(1);
            const batch = nonEmptyBatches[0]!;
            expect(batch.entries).toHaveLength(1);
            const entry = (
              batch.entries as Array<{
                discordChannelId: string;
                discordRoleId: string;
                accessLevel: string;
              }>
            )[0]!;
            expect(entry.discordChannelId).toBe(DISCORD_CHANNEL_1);
            expect(entry.discordRoleId).toBe(NEW_ROLE_A);
            expect(entry.accessLevel).toBe('VIEW');
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  itEffect('Some→Some: old_role_id already set → NO grant re-emit', () => {
    const grants: AccessEntry[] = [
      { group_id: GROUP_A, access_level: 'EDIT', team_channel_id: CHANNEL_1 },
    ];
    const channels: ChannelEntry[] = [
      { id: CHANNEL_1, team_id: TEAM_ID, discord_channel_id: Option.some(DISCORD_CHANNEL_1) },
    ];

    const testLayer = buildTestLayer(grants, channels, {
      insertReturnsOldRole: Option.some(OLD_ROLE_A),
      insertRoleOnlyReturnsOldRole: Option.some(OLD_ROLE_A), // Some→Some — no reapply
    });

    return Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
      Effect.tap(({ client }) =>
        client['Channel/UpsertMappingRoleOnly']({
          team_id: TEAM_ID,
          group_id: GROUP_A,
          discord_role_id: NEW_ROLE_A,
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          // Some→Some: reapplyGroupGrants must NOT be called
          const nonEmptyBatches = grantedBatchCalls.filter((c) => c.entries.length > 0);
          expect(nonEmptyBatches).toHaveLength(0);
        }),
      ),
      Effect.provide(testLayer),
    );
  });

  itEffect(
    'grant on channel with discord_channel_id None (unprovisioned) → grant skipped, no emit',
    () => {
      const grants: AccessEntry[] = [
        { group_id: GROUP_A, access_level: 'VIEW', team_channel_id: CHANNEL_2 },
      ];
      const channels: ChannelEntry[] = [
        // CHANNEL_2 has no discord_channel_id yet
        { id: CHANNEL_2, team_id: TEAM_ID, discord_channel_id: Option.none() },
      ];

      const testLayer = buildTestLayer(grants, channels, {
        insertReturnsOldRole: Option.none(),
        insertRoleOnlyReturnsOldRole: Option.none(), // none→Some, but channel unprovisioned
      });

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.tap(({ client }) =>
          client['Channel/UpsertMappingRoleOnly']({
            team_id: TEAM_ID,
            group_id: GROUP_A,
            discord_role_id: NEW_ROLE_A,
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            // Channel not yet provisioned → no batch emit with entries
            const nonEmptyBatches = grantedBatchCalls.filter((c) => c.entries.length > 0);
            expect(nonEmptyBatches).toHaveLength(0);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  itEffect('group with no grants → no emit, no error', () => {
    const testLayer = buildTestLayer(
      [], // zero grants
      [],
      {
        insertReturnsOldRole: Option.none(),
        insertRoleOnlyReturnsOldRole: Option.none(),
      },
    );

    return Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
      Effect.tap(({ client }) =>
        client['Channel/UpsertMappingRoleOnly']({
          team_id: TEAM_ID,
          group_id: GROUP_A,
          discord_role_id: NEW_ROLE_A,
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          // No grants → no batch emitted with entries
          const nonEmptyBatches = grantedBatchCalls.filter((c) => c.entries.length > 0);
          expect(nonEmptyBatches).toHaveLength(0);
        }),
      ),
      Effect.provide(testLayer),
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3a — UpsertMapping (channel+role path) also fires reapply
// ---------------------------------------------------------------------------

describe('Task 3a — UpsertMapping (channel+role path) also fires reapply', () => {
  beforeEach(resetSpies);

  itEffect(
    'none→Some via UpsertMapping: group has grants → emitManagedAccessGrantedBatch called',
    () => {
      const grants: AccessEntry[] = [
        { group_id: GROUP_A, access_level: 'ADMIN', team_channel_id: CHANNEL_1 },
      ];
      const channels: ChannelEntry[] = [
        { id: CHANNEL_1, team_id: TEAM_ID, discord_channel_id: Option.some(DISCORD_CHANNEL_1) },
      ];

      const testLayer = buildTestLayer(grants, channels, {
        insertReturnsOldRole: Option.none(), // none→Some via UpsertMapping
        insertRoleOnlyReturnsOldRole: Option.none(),
      });

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.tap(({ client }) =>
          client['Channel/UpsertMapping']({
            team_id: TEAM_ID,
            group_id: GROUP_A,
            discord_channel_id: DISCORD_CHANNEL_1,
            discord_role_id: NEW_ROLE_A,
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            const nonEmptyBatches = grantedBatchCalls.filter((c) => c.entries.length > 0);
            expect(nonEmptyBatches).toHaveLength(1);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  itEffect('UpsertMapping: group has zero grants → no emit', () => {
    const testLayer = buildTestLayer([], [], {
      insertReturnsOldRole: Option.none(),
      insertRoleOnlyReturnsOldRole: Option.none(),
    });

    return Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
      Effect.tap(({ client }) =>
        client['Channel/UpsertMapping']({
          team_id: TEAM_ID,
          group_id: GROUP_A,
          discord_channel_id: DISCORD_CHANNEL_1,
          discord_role_id: NEW_ROLE_A,
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const nonEmptyBatches = grantedBatchCalls.filter((c) => c.entries.length > 0);
          expect(nonEmptyBatches).toHaveLength(0);
        }),
      ),
      Effect.provide(testLayer),
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3b tests — Channel/BackfillMissingGroupRoles
// ---------------------------------------------------------------------------

describe('Task 3b — Channel/BackfillMissingGroupRoles', () => {
  beforeEach(resetSpies);

  itEffect(
    'two missing groups + create_discord_channel_on_group=false → two channel_created events, no discordChannelName, discordRoleName set',
    () => {
      const missingGroups: GroupMissingRoleRow[] = [
        {
          group_id: GROUP_A,
          team_id: TEAM_ID,
          name: 'Goalkeepers',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.none(),
        },
        {
          group_id: GROUP_B,
          team_id: TEAM_ID,
          name: 'Defenders',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.none(),
        },
      ];

      const testLayer = buildTestLayer(
        [],
        [],
        {
          insertReturnsOldRole: Option.none(),
          insertRoleOnlyReturnsOldRole: Option.none(),
          missingGroups,
        },
        false, // create_discord_channel_on_group = false
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('count', ({ client }) =>
          client['Channel/BackfillMissingGroupRoles']({
            team_id: Option.some(TEAM_ID),
            limit: Option.some(10),
          }),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(2);
            expect(channelCreatedCalls).toHaveLength(2);
            for (const call of channelCreatedCalls) {
              // Role-only: no channel name
              expect(call.discordChannelName).toBeUndefined();
              // Role name must be set
              expect(call.discordRoleName).toBeDefined();
              expect(typeof call.discordRoleName).toBe('string');
            }
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  itEffect('create_discord_channel_on_group=true → events carry discordChannelName', () => {
    const missingGroups: GroupMissingRoleRow[] = [
      {
        group_id: GROUP_A,
        team_id: TEAM_ID,
        name: 'Goalkeepers',
        emoji: Option.none(),
        color: Option.none(),
        discord_channel_id: Option.none(),
      },
    ];

    const testLayer = buildTestLayer(
      [],
      [],
      {
        insertReturnsOldRole: Option.none(),
        insertRoleOnlyReturnsOldRole: Option.none(),
        missingGroups,
      },
      true, // create_discord_channel_on_group = true
    );

    return Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
      Effect.bind('count', ({ client }) =>
        client['Channel/BackfillMissingGroupRoles']({
          team_id: Option.some(TEAM_ID),
          limit: Option.some(10),
        }),
      ),
      Effect.tap(({ count }) =>
        Effect.sync(() => {
          expect(count).toBe(1);
          expect(channelCreatedCalls).toHaveLength(1);
          // Channel name must be present when create_discord_channel_on_group = true
          expect(channelCreatedCalls[0]?.discordChannelName).toBeDefined();
          expect(typeof channelCreatedCalls[0]?.discordChannelName).toBe('string');
        }),
      ),
      Effect.provide(testLayer),
    );
  });

  itEffect('already-provisioned group → findGroupsMissingRole returns empty → no events', () => {
    // findGroupsMissingRole returns [] because the group already has a role
    const testLayer = buildTestLayer(
      [],
      [],
      {
        insertReturnsOldRole: Option.none(),
        insertRoleOnlyReturnsOldRole: Option.none(),
        missingGroups: [], // empty — already provisioned group excluded
      },
      false,
    );

    return Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
      Effect.bind('count', ({ client }) =>
        client['Channel/BackfillMissingGroupRoles']({
          team_id: Option.some(TEAM_ID),
          limit: Option.some(10),
        }),
      ),
      Effect.tap(({ count }) =>
        Effect.sync(() => {
          expect(count).toBe(0);
          expect(channelCreatedCalls).toHaveLength(0);
        }),
      ),
      Effect.provide(testLayer),
    );
  });

  itEffect(
    'group with unprocessed channel_created event → in-flight guard in query → no new event',
    () => {
      // findGroupsMissingRole already excludes in-flight groups (guard is in the SQL query)
      const testLayer = buildTestLayer(
        [],
        [],
        {
          insertReturnsOldRole: Option.none(),
          insertRoleOnlyReturnsOldRole: Option.none(),
          missingGroups: [], // excluded by SQL predicate
        },
        false,
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('count', ({ client }) =>
          client['Channel/BackfillMissingGroupRoles']({
            team_id: Option.none(),
            limit: Option.none(),
          }),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(0);
            expect(channelCreatedCalls).toHaveLength(0);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  itEffect(
    'limit bounds the number of groups enqueued via findGroupsMissingRole; returns count',
    () => {
      // The handler passes the limit to findGroupsMissingRole. Our mock respects whatever
      // missingGroups array is provided. We seed exactly 3 to match the limit.
      const limitedGroups: GroupMissingRoleRow[] = [
        {
          group_id: '00000000-0000-0000-0003-0000000000a0' as GroupModel.GroupId,
          team_id: TEAM_ID,
          name: 'Group 0',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.none(),
        },
        {
          group_id: '00000000-0000-0000-0003-0000000000a1' as GroupModel.GroupId,
          team_id: TEAM_ID,
          name: 'Group 1',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.none(),
        },
        {
          group_id: '00000000-0000-0000-0003-0000000000a2' as GroupModel.GroupId,
          team_id: TEAM_ID,
          name: 'Group 2',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.none(),
        },
      ];

      const testLayer = buildTestLayer(
        [],
        [],
        {
          insertReturnsOldRole: Option.none(),
          insertRoleOnlyReturnsOldRole: Option.none(),
          missingGroups: limitedGroups,
        },
        false,
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('count', ({ client }) =>
          client['Channel/BackfillMissingGroupRoles']({
            team_id: Option.some(TEAM_ID),
            limit: Option.some(3),
          }),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(3);
            expect(channelCreatedCalls).toHaveLength(3);
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  // -------------------------------------------------------------------------
  // NEW: channel-exists (partial provisioning) branch
  // -------------------------------------------------------------------------

  itEffect(
    'group with discord_channel_id already set (partial provisioning) → emits channel_created with existingChannelId=Some AND discordChannelName=undefined (LINK branch, not CREATE branch)',
    () => {
      // This is the duplicate-channel prevention regression test.
      // When a group already has discord_channel_id set but still lacks a role,
      // BackfillMissingGroupRoles must route to the LINK branch:
      //   emitChannelCreated(..., Option.some(existingChannelId), undefined, roleName, ...)
      // NOT the CREATE branch:
      //   emitChannelCreated(..., Option.none(), channelName, roleName, ...)
      const EXISTING_DISCORD_CHANNEL = '444444444444444444' as Discord.Snowflake;

      const missingGroups: GroupMissingRoleRow[] = [
        {
          group_id: GROUP_A,
          team_id: TEAM_ID,
          name: 'Strikers',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.some(EXISTING_DISCORD_CHANNEL), // has channel, no role
        },
      ];

      // create_discord_channel_on_group=true to prove the channel-exists branch
      // ignores that flag and does NOT generate a channel name.
      const testLayer = buildTestLayer(
        [],
        [],
        {
          insertReturnsOldRole: Option.none(),
          insertRoleOnlyReturnsOldRole: Option.none(),
          missingGroups,
        },
        true, // create_discord_channel_on_group = true (must be ignored for this group)
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('count', ({ client }) =>
          client['Channel/BackfillMissingGroupRoles']({
            team_id: Option.some(TEAM_ID),
            limit: Option.some(10),
          }),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(1);
            expect(channelCreatedCalls).toHaveLength(1);

            const call = channelCreatedCalls[0]!;

            // LINK branch: existingChannelId must be Some(<the channel id>)
            expect(Option.isSome(call.existingChannelId)).toBe(true);
            expect(Option.getOrNull(call.existingChannelId)).toBe(EXISTING_DISCORD_CHANNEL);

            // LINK branch: no new channel name — would cause duplicate channel if set
            expect(call.discordChannelName).toBeUndefined();

            // Role name must still be set (that's the whole point of the backfill)
            expect(call.discordRoleName).toBeDefined();
            expect(typeof call.discordRoleName).toBe('string');
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  itEffect(
    'contrast: group with discord_channel_id=None + create_discord_channel_on_group=true → CREATE branch (existingChannelId=None, discordChannelName=defined)',
    () => {
      // Contrast test: the discord_channel_id=None case must still use the CREATE branch
      // so we can tell the two branches apart.
      const missingGroups: GroupMissingRoleRow[] = [
        {
          group_id: GROUP_B,
          team_id: TEAM_ID,
          name: 'Midfielders',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.none(), // no channel yet
        },
      ];

      const testLayer = buildTestLayer(
        [],
        [],
        {
          insertReturnsOldRole: Option.none(),
          insertRoleOnlyReturnsOldRole: Option.none(),
          missingGroups,
        },
        true, // create_discord_channel_on_group = true
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('count', ({ client }) =>
          client['Channel/BackfillMissingGroupRoles']({
            team_id: Option.some(TEAM_ID),
            limit: Option.some(10),
          }),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(1);
            expect(channelCreatedCalls).toHaveLength(1);

            const call = channelCreatedCalls[0]!;

            // CREATE branch: existingChannelId must be None
            expect(Option.isNone(call.existingChannelId)).toBe(true);

            // CREATE branch: channel name must be defined
            expect(call.discordChannelName).toBeDefined();
            expect(typeof call.discordChannelName).toBe('string');

            // Role name must also be set
            expect(call.discordRoleName).toBeDefined();
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );

  itEffect(
    'mixed batch: one group with existing channel + one without → correct routing for each',
    () => {
      const EXISTING_DISCORD_CHANNEL = '555555555555555555' as Discord.Snowflake;

      const missingGroups: GroupMissingRoleRow[] = [
        {
          group_id: GROUP_A,
          team_id: TEAM_ID,
          name: 'Strikers',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.some(EXISTING_DISCORD_CHANNEL), // LINK branch
        },
        {
          group_id: GROUP_B,
          team_id: TEAM_ID,
          name: 'Keepers',
          emoji: Option.none(),
          color: Option.none(),
          discord_channel_id: Option.none(), // CREATE branch
        },
      ];

      const testLayer = buildTestLayer(
        [],
        [],
        {
          insertReturnsOldRole: Option.none(),
          insertRoleOnlyReturnsOldRole: Option.none(),
          missingGroups,
        },
        true, // create_discord_channel_on_group = true
      );

      return Effect.Do.pipe(
        Effect.bind('client', () => RpcTest.makeClient(ChannelRpcGroup.ChannelRpcGroup)),
        Effect.bind('count', ({ client }) =>
          client['Channel/BackfillMissingGroupRoles']({
            team_id: Option.some(TEAM_ID),
            limit: Option.some(10),
          }),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(2);
            expect(channelCreatedCalls).toHaveLength(2);

            const callA = channelCreatedCalls.find((c) => c.groupId === GROUP_A)!;
            const callB = channelCreatedCalls.find((c) => c.groupId === GROUP_B)!;

            // GROUP_A — LINK branch
            expect(Option.isSome(callA.existingChannelId)).toBe(true);
            expect(Option.getOrNull(callA.existingChannelId)).toBe(EXISTING_DISCORD_CHANNEL);
            expect(callA.discordChannelName).toBeUndefined();

            // GROUP_B — CREATE branch
            expect(Option.isNone(callB.existingChannelId)).toBe(true);
            expect(callB.discordChannelName).toBeDefined();
          }),
        ),
        Effect.provide(testLayer),
      );
    },
  );
});
