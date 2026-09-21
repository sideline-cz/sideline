import { it as itEffect } from '@effect/vitest';
import type { Auth, Discord, GroupModel, Team, TeamMember } from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { PersonalEventOverflowCategoriesRepository } from '~/repositories/PersonalEventOverflowCategoriesRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SudoSessionsRepository } from '~/repositories/SudoSessionsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { GuildsRpcLive } from '~/rpc/guild/index.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000099' as Team.TeamId;
const GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const PARENT_GROUP_ID = '00000000-0000-0000-0000-000000000031' as GroupModel.GroupId;
const INVITER_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const SYSTEM_LOG_CHANNEL_ID = '777777777777777777' as Discord.Snowflake;
const WELCOME_CHANNEL_ID = '888888888888888888' as Discord.Snowflake;

const VALID_CODE_WITH_GROUP = 'INVITE-WITH-GROUP';
const VALID_CODE_NO_GROUP = 'INVITE-NO-GROUP';
const EXPIRED_CODE = 'EXPIRED-INVITE';
const NONEXISTENT_CODE = 'NONEXISTENT';
const CROSS_TEAM_CODE = 'CROSS-TEAM-CODE';

// PR-8: a role Sideline manages (mapped to a Discord role) plus a second one, so the
// role_unassigned path has something distinct from the role_assigned path to exercise.
const CAPTAIN_ROLE_ID =
  '00000000-0000-0000-0000-000000000050' as import('@sideline/domain').Role.RoleId;
const CAPTAIN_DISCORD_ROLE_ID = '500000000000000001' as Discord.Snowflake;
const COACH_ROLE_ID =
  '00000000-0000-0000-0000-000000000051' as import('@sideline/domain').Role.RoleId;
const COACH_DISCORD_ROLE_ID = '500000000000000002' as Discord.Snowflake;
// A Discord role with NO `discord_role_mappings` row — Sideline must never touch it.
const UNMANAGED_DISCORD_ROLE_ID = '500000000000000099' as Discord.Snowflake;
// Blocker A (whole-series review): a mapping Sideline ADOPTED rather than created — a
// hand-made Discord role held by members Sideline never assigned it to via `member_roles`.
// The diff must be free to ADD this role, but must never STRIP it.
const ADOPTED_ROLE_ID =
  '00000000-0000-0000-0000-000000000052' as import('@sideline/domain').Role.RoleId;
const ADOPTED_DISCORD_ROLE_ID = '500000000000000003' as Discord.Snowflake;
// bug 3da93506: a Sideline role with NO `discord_role_mappings` row at all — the inverse of
// `UNMANAGED_DISCORD_ROLE_ID` (a DISCORD role Sideline does not manage). Deliberately absent from
// `discordRoleMappings` AND from `MockRolesRepository`: the reconcile diff must be able to
// bootstrap it from `desired` alone (the bot's `ensureMapping` adopts-or-creates the Discord role
// when it handles the event), without a mapping row and without a `findRoleById` lookup.
const UNMAPPED_ROLE_ID =
  '00000000-0000-0000-0000-000000000054' as import('@sideline/domain').Role.RoleId;
// A role linked to GROUP_ID (`role_groups`), exercised by the group-scoped-invite tests below —
// U2 seeds `groupRoles` with it so the diff has something to assign once the group bind lands
// before the role diff runs.
const GROUP_ROLE_ID =
  '00000000-0000-0000-0000-000000000053' as import('@sideline/domain').Role.RoleId;
const GROUP_DISCORD_ROLE_ID = '500000000000000004' as Discord.Snowflake;

// bug fix-group-channel-discord-join (PR 1) — the group's OWN Discord role, as recorded in
// `discord_channel_mappings.discord_role_id` (created by `createGroup`'s `emitChannelCreated` /
// the bot's `handleCreated.ts`). This is a DIFFERENT concept from `GROUP_ROLE_ID` above (a
// Sideline `Role` linked to the group via `role_groups`, diffed through `discord_role_mappings`):
// a group with no `role_groups` row at all — the common case — contributes NOTHING to the
// `role_sync_events` diff, so these are the only ids `emitMemberGroupChannelRoles` ever emits
// `member_added` against.
const GROUP_CHANNEL_ROLE_ID = '600000000000000001' as Discord.Snowflake;
const GROUP_CHANNEL_DISCORD_ID = '650000000000000001' as Discord.Snowflake;
const PARENT_CHANNEL_ROLE_ID = '600000000000000002' as Discord.Snowflake;
const PARENT_CHANNEL_DISCORD_ID = '650000000000000002' as Discord.Snowflake;
// A group with NO `discord_channel_mappings` row by default (U5); tests that need a role-less or
// channel-cleared mapping (U6/U7) push one into `discordChannelMappings` themselves.
const UNMAPPED_GROUP_ID = '00000000-0000-0000-0000-000000000032' as GroupModel.GroupId;
// U8 ("unmanaged roles are inert") reuses the existing `UNMANAGED_DISCORD_ROLE_ID` above (a
// Discord role with no `discord_role_mappings` row) — it is equally unmanaged on the channel-role
// axis, since it is never any group's `discord_channel_mappings.discord_role_id` either.

// ---------------------------------------------------------------------------
// In-memory stores (reset between tests)
// ---------------------------------------------------------------------------

let teamMembersAdded: Array<{ team_id: string; user_id: string }>;
let groupMembersAdded: Array<{ group_id: string; member_id: string }>;

// Deterministic per-discord_id user id so repeated calls with the same discord_id resolve to the
// same user (needed for the "already active member" scenarios — PR-8's actual bug).
const userIdForDiscordId = (discordId: string) => `user-${discordId}`;

type MembershipRow = {
  readonly id: TeamMember.TeamMemberId;
  readonly team_id: string;
  readonly user_id: string;
  active: boolean;
};
// Keyed by user_id.
let memberships: Map<string, MembershipRow>;
// Keyed by TeamMemberId (string) -> discord_joined_at, `undefined` = never set, `null` = cleared.
let discordJoinedAt: Map<string, Date | null | undefined>;
// Keyed by TeamMemberId (string) -> the member's effective Sideline role ids (PR-8's "desired").
let effectiveRoles: Map<string, ReadonlyArray<{ role_id: string; role_name: string }>>;
// Keyed by TeamMemberId (string) -> role ids `member_role_grants` records Sideline itself having
// granted this member (blocker, whole-series review of commit 46806427). The unassign decision
// keys on THIS, not on `discordRoleMappings[].adopted` — see `reconcileMemberDiscordRoles.ts`.
let grantedRoleIds: Map<string, ReadonlyArray<string>>;
// Configurable `discord_role_mappings` rows for TEAM_ID.
let discordRoleMappings: Array<{
  id: string;
  team_id: string;
  role_id: string;
  discord_role_id: string;
  adopted: boolean;
}>;
let roleAssignedEvents: Array<{
  teamId: string;
  roleId: string;
  roleName: string;
  teamMemberId: string;
  discordUserId: string;
}>;
let roleUnassignedEvents: Array<typeof roleAssignedEvents extends Array<infer T> ? T : never>;
let markMembersBackfilledCalls: Array<string>;
let nextMemberId = 1;
// Ordering probe (bug 3da93506): `addMemberById` pushes 'group-add', `findEffectiveRoleIdsForMember`
// pushes 'role-diff' before returning — lets tests assert the group bind happened before the diff
// ran, without coupling to timing.
let callLog: Array<string>;
// Records instead of swallows every `ChannelSyncEventsRepository` call — see the Proxy below.
let channelSyncCalls: Array<{ method: string; args: Array<unknown> }>;
// Flat group -> roles map, U2 ONLY. Deliberately flat: NO ancestor walk, NO `is_archived`
// handling. This models only "a group membership contributes roles", which is all this file
// needs to observe an ordering effect. The real rule (recursive `groups.parent_id` walk,
// archived-ancestor severing, cycle guard) lives in `repositories/effectiveRoles.ts` and is
// tested ONLY against a real database — see
// `test/integration/repositories/TeamMembersRepository.groupRoles.test.ts` and
// `middleGroupArchivedChain.test.ts`. Do not grow this into a second implementation of that
// fragment.
let groupRoles: Map<string, ReadonlyArray<{ role_id: string; role_name: string }>>;
// Configurable recency fallback (`findRecentByUserAndGuildWithContext`), keyed by discord_id ->
// invite code, looked up against `inviteContexts`. Needed by U5.
let recentAcceptances: Map<string, string>;

// bug fix-group-channel-discord-join (PR 1) ---------------------------------------------------
//
// `GroupsRepository.findActiveGroupsWithAncestorsForMember`'s mock: keyed by TeamMemberId,
// explicitly set per test to whatever "the member's non-archived groups + active ancestors"
// should resolve to. Deliberately FLAT/DUMB — no `parent_id` walk, no `is_archived` handling, no
// derivation from `groupMembersAdded`. The real recursive CTE (severing on an archived node,
// cycle guard, cross-team isolation) is proved ONLY against a real database — see
// `test/integration/rpc/registerMemberGroupChannelRoleSync.test.ts` and the
// `GroupsRepository` repository-integration suite. Do not grow this into a second
// implementation of that query.
let desiredGroupsByMember: Map<
  string,
  ReadonlyArray<{ readonly id: GroupModel.GroupId; readonly name: string }>
>;
// `DiscordChannelMappingRepository.findAllByTeam`'s mock: every row this team's groups have.
// Defaulted (see `resetStores`) to GROUP_ID and PARENT_GROUP_ID both fully provisioned (channel +
// role) — the "reported bug" baseline (U1). Tests override by pushing/removing rows.
type ChannelMappingRow = {
  readonly group_id: Option.Option<GroupModel.GroupId>;
  readonly discord_channel_id: Option.Option<Discord.Snowflake>;
  readonly discord_role_id: Option.Option<Discord.Snowflake>;
};
let discordChannelMappings: Array<ChannelMappingRow>;

const seedActiveMember = (discordId: string, memberId: TeamMember.TeamMemberId) => {
  memberships.set(userIdForDiscordId(discordId), {
    id: memberId,
    team_id: TEAM_ID,
    user_id: userIdForDiscordId(discordId),
    active: true,
  });
};

const inviteContexts: ReadonlyMap<
  string,
  {
    code: string;
    team_id: Team.TeamId;
    group_id: Option.Option<GroupModel.GroupId>;
    group_name: Option.Option<string>;
    group_color: Option.Option<string>;
    inviter_discord_id: Option.Option<Discord.Snowflake>;
    welcome_message_template: Option.Option<string>;
    welcome_channel_id: Option.Option<Discord.Snowflake>;
    system_log_channel_id: Option.Option<Discord.Snowflake>;
    active: boolean;
  }
> = new Map([
  [
    VALID_CODE_WITH_GROUP,
    {
      code: VALID_CODE_WITH_GROUP,
      team_id: TEAM_ID,
      group_id: Option.some(GROUP_ID),
      group_name: Option.some('Strikers'),
      group_color: Option.some('#ff0000'),
      inviter_discord_id: Option.some(INVITER_DISCORD_ID),
      welcome_message_template: Option.some('Welcome {memberMention} to {groupName}!'),
      welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
      system_log_channel_id: Option.some(SYSTEM_LOG_CHANNEL_ID),
      active: true,
    },
  ],
  [
    VALID_CODE_NO_GROUP,
    {
      code: VALID_CODE_NO_GROUP,
      team_id: TEAM_ID,
      group_id: Option.none(),
      group_name: Option.none(),
      group_color: Option.none(),
      inviter_discord_id: Option.some(INVITER_DISCORD_ID),
      welcome_message_template: Option.some('Welcome {memberMention}!'),
      welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
      system_log_channel_id: Option.some(SYSTEM_LOG_CHANNEL_ID),
      active: true,
    },
  ],
  [
    EXPIRED_CODE,
    {
      code: EXPIRED_CODE,
      team_id: TEAM_ID,
      group_id: Option.none(),
      group_name: Option.none(),
      group_color: Option.none(),
      inviter_discord_id: Option.none(),
      welcome_message_template: Option.none(),
      welcome_channel_id: Option.none(),
      system_log_channel_id: Option.none(),
      active: false,
    },
  ],
  [
    CROSS_TEAM_CODE,
    {
      code: CROSS_TEAM_CODE,
      team_id: OTHER_TEAM_ID,
      group_id: Option.none(),
      group_name: Option.none(),
      group_color: Option.none(),
      inviter_discord_id: Option.none(),
      welcome_message_template: Option.none(),
      welcome_channel_id: Option.none(),
      system_log_channel_id: Option.none(),
      active: true,
    },
  ],
]);

const resetStores = () => {
  teamMembersAdded = [];
  groupMembersAdded = [];
  memberships = new Map();
  discordJoinedAt = new Map();
  effectiveRoles = new Map();
  grantedRoleIds = new Map();
  discordRoleMappings = [
    {
      id: 'mapping-captain',
      team_id: TEAM_ID,
      role_id: CAPTAIN_ROLE_ID,
      discord_role_id: CAPTAIN_DISCORD_ROLE_ID,
      adopted: false,
    },
    {
      id: 'mapping-coach',
      team_id: TEAM_ID,
      role_id: COACH_ROLE_ID,
      discord_role_id: COACH_DISCORD_ROLE_ID,
      adopted: false,
    },
    {
      id: 'mapping-adopted',
      team_id: TEAM_ID,
      role_id: ADOPTED_ROLE_ID,
      discord_role_id: ADOPTED_DISCORD_ROLE_ID,
      adopted: true,
    },
    {
      id: 'mapping-group-role',
      team_id: TEAM_ID,
      role_id: GROUP_ROLE_ID,
      discord_role_id: GROUP_DISCORD_ROLE_ID,
      adopted: false,
    },
  ];
  roleAssignedEvents = [];
  roleUnassignedEvents = [];
  markMembersBackfilledCalls = [];
  nextMemberId = 1;
  callLog = [];
  channelSyncCalls = [];
  groupRoles = new Map([[GROUP_ID, [{ role_id: GROUP_ROLE_ID, role_name: 'Strikers Player' }]]]);
  recentAcceptances = new Map();
  desiredGroupsByMember = new Map();
  discordChannelMappings = [
    {
      group_id: Option.some(GROUP_ID),
      discord_channel_id: Option.some(GROUP_CHANNEL_DISCORD_ID),
      discord_role_id: Option.some(GROUP_CHANNEL_ROLE_ID),
    },
    {
      group_id: Option.some(PARENT_GROUP_ID),
      discord_channel_id: Option.some(PARENT_CHANNEL_DISCORD_ID),
      discord_role_id: Option.some(PARENT_CHANNEL_ROLE_ID),
    },
  ];
};

beforeEach(resetStores);
afterEach(resetStores);

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockTeamsRepository = Layer.succeed(TeamsRepository, {
  findByGuildId: (guildId: Discord.Snowflake) => {
    if (guildId === GUILD_ID) {
      return Effect.succeed(
        Option.some({
          id: TEAM_ID,
          guild_id: GUILD_ID,
          name: 'Test Team',
          welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
          system_log_channel_id: Option.some(SYSTEM_LOG_CHANNEL_ID),
          welcome_message_template: Option.some('Welcome {memberMention} to {groupName}!'),
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockUsersRepository = Layer.succeed(UsersRepository, {
  upsertFromDiscord: (input: { discord_id: string; username: string }) => {
    const id = userIdForDiscordId(input.discord_id) as Auth.UserId;
    return Effect.succeed({
      id,
      discord_id: input.discord_id,
      username: input.username,
      avatar: Option.none(),
      is_profile_complete: false,
    });
  },
  findById: () => Effect.succeed(Option.none()),
  findByDiscordId: (discordId: string) =>
    Effect.succeed(
      Option.some({
        id: userIdForDiscordId(discordId) as Auth.UserId,
        discord_id: discordId,
        username: discordId,
        avatar: Option.none(),
        is_profile_complete: false,
      }),
    ),
} as any);

const MockTeamMembersRepository = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (
    teamId: string,
    userId: string,
    options?: { includeInactive?: boolean },
  ) => {
    const row = memberships.get(userId);
    if (!row || row.team_id !== teamId) return Effect.succeed(Option.none());
    if (!row.active && options?.includeInactive !== true) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some({ ...row, role_names: [], permissions: [] }));
  },
  addMember: (input: { team_id: string; user_id: string }) => {
    teamMembersAdded.push({ team_id: input.team_id, user_id: input.user_id });
    const memberId = `member-${nextMemberId++}` as TeamMember.TeamMemberId;
    memberships.set(input.user_id, {
      id: memberId,
      team_id: input.team_id,
      user_id: input.user_id,
      active: true,
    });
    return Effect.succeed({
      id: memberId,
      team_id: input.team_id,
      user_id: input.user_id,
      active: true,
      jersey_number: Option.none(),
      joined_at: DateTime.nowUnsafe(),
    });
  },
  reactivateMember: (memberId: string) => {
    for (const row of memberships.values()) {
      if (row.id === memberId) row.active = true;
    }
    return Effect.succeed({
      id: memberId,
      active: true,
      jersey_number: Option.none(),
      joined_at: DateTime.nowUnsafe(),
    });
  },
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  findById: (memberId: string) => {
    for (const row of memberships.values()) {
      if (row.id === memberId) return Effect.succeed(Option.some({ active: row.active }));
    }
    return Effect.succeed(Option.none());
  },
  deactivateMemberByIds: (_teamId: string, memberId: string) => {
    for (const row of memberships.values()) {
      if (row.id === memberId) row.active = false;
    }
    return Effect.void;
  },
  hasOtherActiveManager: () => Effect.succeed(true),
  findEffectiveRoleIdsForMember: (memberId: string) => {
    callLog.push('role-diff');
    const fromGroups = groupMembersAdded
      .filter((g) => g.member_id === memberId)
      .flatMap((g) => groupRoles.get(g.group_id) ?? []);
    const merged = new Map<string, { role_id: string; role_name: string }>();
    for (const role of [...(effectiveRoles.get(memberId) ?? []), ...fromGroups]) {
      merged.set(role.role_id, role);
    }
    return Effect.succeed(Array.from(merged.values()));
  },
  findGrantedRoleIds: (memberId: string) => Effect.succeed(grantedRoleIds.get(memberId) ?? []),
  recordRoleGrant: (memberId: string, roleId: string) => {
    grantedRoleIds.set(memberId, [...(grantedRoleIds.get(memberId) ?? []), roleId]);
    return Effect.void;
  },
  clearRoleGrant: (memberId: string, roleId: string) => {
    grantedRoleIds.set(
      memberId,
      (grantedRoleIds.get(memberId) ?? []).filter((id) => id !== roleId),
    );
    return Effect.void;
  },
  markDiscordJoined: (memberId: string) => {
    if (discordJoinedAt.get(memberId) == null) discordJoinedAt.set(memberId, new Date());
    return Effect.void;
  },
  clearDiscordJoined: (memberId: string) => {
    discordJoinedAt.set(memberId, null);
    return Effect.void;
  },
} as any);

const MockGroupsRepository = Layer.succeed(GroupsRepository, {
  addMemberById: (groupId: string, memberId: string) => {
    callLog.push('group-add');
    groupMembersAdded.push({ group_id: groupId, member_id: memberId });
    return Effect.void;
  },
  findGroupsByTeamId: () => Effect.succeed([]),
  findGroupById: (id: GroupModel.GroupId) => {
    if (id === GROUP_ID) {
      return Effect.succeed(
        Option.some({
          id: GROUP_ID,
          team_id: TEAM_ID,
          name: 'Strikers',
          color: Option.some('#ff0000'),
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  getAncestorIds: () => Effect.succeed([]),
  // Note: the method is `getActiveAncestors`, NOT `getAncestors`.
  getActiveAncestors: (groupId: GroupModel.GroupId, _teamId: Team.TeamId) => {
    if (groupId === GROUP_ID) {
      return Effect.succeed([{ id: PARENT_GROUP_ID, name: 'Seniors' }]);
    }
    return Effect.succeed([]);
  },
  getDescendantMemberIds: () => Effect.succeed([]),
  findGroupIdsByMember: () => Effect.succeed([]),
  removeAllForMember: () => Effect.void,
  // bug fix-group-channel-discord-join (PR 1) — flat/dumb, see `desiredGroupsByMember`'s
  // declaration above for why this must NOT grow a real recursive walk.
  findActiveGroupsWithAncestorsForMember: (
    memberId: TeamMember.TeamMemberId,
    _teamId: Team.TeamId,
  ) => Effect.succeed(desiredGroupsByMember.get(memberId) ?? []),
} as any);

const MockRostersRepository = Layer.succeed(RostersRepository, {
  findRosterIdsByMember: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  removeAllForMember: () => Effect.void,
} as any);

const MockTeamInvitesRepository = Layer.succeed(TeamInvitesRepository, {
  findByCodeWithContext: (code: string) => {
    const ctx = inviteContexts.get(code);
    if (!ctx?.active) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        ...ctx,
        inviter_username: 'inviter-user',
      }),
    );
  },
  findByCode: (code: string) => {
    const ctx = inviteContexts.get(code);
    if (!ctx?.active) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(ctx));
  },
  create: () => Effect.die(new Error('Not implemented')),
  findByTeam: () => Effect.succeed([]),
  listForTeam: () => Effect.succeed([]),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
  deactivateById: () => Effect.succeed(Option.none()),
} as any);

const MockInviteAcceptancesRepository = Layer.succeed(InviteAcceptancesRepository, {
  _tag: 'api/InviteAcceptancesRepository',
  findByDiscordCodeWithContext: (code: string) => {
    const ctx = inviteContexts.get(code);
    if (!ctx?.active) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        ...ctx,
        inviter_username: 'inviter-user',
      }),
    );
  },
  findRecentByUserAndGuildWithContext: (discordId: string, _guildId: string) => {
    const code = recentAcceptances.get(discordId);
    const ctx = code == null ? undefined : inviteContexts.get(code);
    if (!ctx?.active) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        ...ctx,
        inviter_username: 'inviter-user',
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  findById: () => Effect.succeed(Option.none()),
  findPending: () => Effect.succeed([]),
  setDiscordCode: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockBotGuildsRepository = Layer.succeed(BotGuildsRepository, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  exists: () => Effect.succeed(false),
  findAll: () => Effect.succeed([]),
  markMembersBackfilled: (guildId: string) => {
    markMembersBackfilledCalls.push(guildId);
    return Effect.void;
  },
} as any);

const MockDiscordChannelsRepository = Layer.succeed(DiscordChannelsRepository, {
  syncChannels: () => Effect.void,
  findByGuildId: () => Effect.succeed([]),
  upsertChannel: () => Effect.void,
  deleteChannel: () => Effect.void,
  updateChannelName: () => Effect.void,
} as any);

const MockDiscordRoleMappingRepository = Layer.succeed(DiscordRoleMappingRepository, {
  findAllByTeam: (teamId: string) =>
    Effect.succeed(discordRoleMappings.filter((m) => m.team_id === teamId)),
} as any);

const MockDiscordChannelMappingRepository = Layer.succeed(DiscordChannelMappingRepository, {
  // bug fix-group-channel-discord-join (PR 1) — configurable via `discordChannelMappings`
  // (defaulted in `resetStores` to GROUP_ID + PARENT_GROUP_ID both fully provisioned). Every row
  // here belongs to TEAM_ID; a lookup for any other team gets nothing.
  findAllByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(teamId === TEAM_ID ? discordChannelMappings : []),
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
} as any);

const MockTeamSettingsRepository = Layer.succeed(TeamSettingsRepository, {
  findByTeamId: () => Effect.succeed(Option.none()),
} as any);

const MockPersonalEventChannelsRepository = Layer.succeed(PersonalEventChannelsRepository, {
  findByMemberAndEvent: () => Effect.succeed(Option.none()),
  findByEvent: () => Effect.succeed([]),
  reserve: () => Effect.succeed(Option.none()),
  save: () => Effect.void,
  delete: () => Effect.void,
  findPersonalChannelTargetCategory: () => Effect.succeed(Option.none()),
} as any);

const MockPersonalEventOverflowCategoriesRepository = Layer.succeed(
  PersonalEventOverflowCategoriesRepository,
  {
    findByGuild: () => Effect.succeed([]),
    allocate: () => Effect.succeed(Option.none()),
    save: () => Effect.void,
  } as any,
);

const MockRolesRepository = Layer.succeed(RolesRepository, {
  findRoleById: (roleId: string) => {
    if (roleId === CAPTAIN_ROLE_ID) {
      return Effect.succeed(
        Option.some({ id: CAPTAIN_ROLE_ID, team_id: TEAM_ID, name: 'Captain' }),
      );
    }
    if (roleId === COACH_ROLE_ID) {
      return Effect.succeed(Option.some({ id: COACH_ROLE_ID, team_id: TEAM_ID, name: 'Coach' }));
    }
    if (roleId === ADOPTED_ROLE_ID) {
      return Effect.succeed(
        Option.some({ id: ADOPTED_ROLE_ID, team_id: TEAM_ID, name: 'Adopted' }),
      );
    }
    if (roleId === GROUP_ROLE_ID) {
      return Effect.succeed(
        Option.some({ id: GROUP_ROLE_ID, team_id: TEAM_ID, name: 'Strikers Player' }),
      );
    }
    return Effect.succeed(Option.none());
  },
} as any);

const MockRoleSyncEventsRepository = Layer.succeed(RoleSyncEventsRepository, {
  emitRoleAssigned: (
    teamId: string,
    roleId: string,
    roleName: string,
    teamMemberId: string,
    discordUserId: string,
  ) => {
    roleAssignedEvents.push({ teamId, roleId, roleName, teamMemberId, discordUserId });
    return Effect.void;
  },
  emitRoleUnassigned: (
    teamId: string,
    roleId: string,
    roleName: string,
    teamMemberId: string,
    discordUserId: string,
  ) => {
    roleUnassignedEvents.push({ teamId, roleId, roleName, teamMemberId, discordUserId });
    return Effect.void;
  },
  emitRoleCreated: () => Effect.void,
  emitRoleDeleted: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  // Purely illustrative for test 10 — the level-based diff never reads this state, so marking an
  // event failed has no bearing on whether the next pass re-emits it.
  markFailed: () => Effect.void,
} as any);

const MockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      return Effect.succeed([]);
    },
    {
      safe: undefined as any,
      withoutTransforms: function (this: any) {
        return this;
      },
      reserve: Effect.die(new Error('reserve not implemented')),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | any, R> =>
        effect,
      reactive: () => Effect.succeed([] as never[]),
      reactiveMailbox: () => Effect.die(new Error('reactiveMailbox not implemented')),
      unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([] as never[]),
      literal: (_sql: string) => ({ _tag: 'Fragment' as const, segments: [] }),
      in: (..._args: unknown[]) => Effect.succeed([] as never[]),
      insert: (..._args: unknown[]) => Effect.succeed([] as never[]),
      update: (..._args: unknown[]) => Effect.succeed([] as never[]),
      updateValues: (..._args: unknown[]) => Effect.succeed([] as never[]),
      and: (..._args: unknown[]) => Effect.succeed([] as never[]),
      or: (..._args: unknown[]) => Effect.succeed([] as never[]),
    },
  ) as unknown as SqlClient.SqlClient,
);

const TestLayer = GuildsRpcLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      MockTeamsRepository,
      MockUsersRepository,
      MockTeamMembersRepository,
      MockGroupsRepository,
      MockTeamInvitesRepository,
      MockInviteAcceptancesRepository,
      MockBotGuildsRepository,
      MockDiscordChannelsRepository,
      MockDiscordRoleMappingRepository,
      MockDiscordChannelMappingRepository,
      MockTeamSettingsRepository,
      MockPersonalEventChannelsRepository,
      MockPersonalEventOverflowCategoriesRepository,
      MockRolesRepository,
      MockRoleSyncEventsRepository,
      MockSqlClientLayer,
      Layer.succeed(EventsRepository, new Proxy({} as any, { get: () => () => Effect.void })),
      Layer.succeed(DiscordRolesRepository, new Proxy({} as any, { get: () => () => Effect.void })),
      Layer.succeed(SudoSessionsRepository, new Proxy({} as any, { get: () => () => Effect.void })),
      MockRostersRepository,
      // Records instead of swallowing. Stays a Proxy so EVERY ChannelSyncEventsRepository method
      // keeps existing — `deactivateMemberAndCascade` calls `emitRosterMemberRemoved` and
      // `emitMemberRemoved` through this same layer, and the `Guild/RemoveMember` test below
      // depends on them.
      Layer.succeed(
        ChannelSyncEventsRepository,
        new Proxy({} as any, {
          get:
            (_t, prop) =>
            (...args: Array<unknown>) => {
              channelSyncCalls.push({ method: String(prop), args });
              return Effect.void;
            },
        }),
      ),
      Layer.succeed(PendingGuildJoinsRepository, {
        _tag: 'api/PendingGuildJoinsRepository',
        enqueue: () => Effect.void,
        listPending: () => Effect.succeed([]),
        markDone: () => Effect.void,
        markFailed: () => Effect.void,
      } as never),
    ),
  ),
);

// ---------------------------------------------------------------------------
// RPC call helpers
// ---------------------------------------------------------------------------

const withRpcClient = <A>(run: (rpc: any) => Effect.Effect<A, any, any>) =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(run),
    ),
  ).pipe(Effect.provide(TestLayer));

const callRegisterMember = (payload: {
  discord_id: string;
  username: string;
  invite_code: Option.Option<string>;
  roles?: ReadonlyArray<string>;
  source?: Option.Option<'member_add' | 'reconcile'>;
}) =>
  withRpcClient((rpc) =>
    rpc['Guild/RegisterMember']({
      guild_id: GUILD_ID,
      discord_id: payload.discord_id,
      username: payload.username,
      avatar: Option.none(),
      roles: payload.roles ?? [],
      nickname: Option.none(),
      display_name: Option.none(),
      invite_code: payload.invite_code,
      source: payload.source ?? Option.some('member_add'),
    }),
  ) as Effect.Effect<RegisterMemberResult, any, never>;

const callRemoveMember = (discordId: string) =>
  withRpcClient((rpc) => rpc['Guild/RemoveMember']({ guild_id: GUILD_ID, discord_id: discordId }));

const callReconcileMembers = (
  members: ReadonlyArray<{ discord_id: string; username: string; roles: ReadonlyArray<string> }>,
  complete: boolean,
) =>
  withRpcClient((rpc) =>
    rpc['Guild/ReconcileMembers']({
      guild_id: GUILD_ID,
      complete,
      members: members.map((m) => ({
        discord_id: m.discord_id,
        username: m.username,
        avatar: Option.none(),
        roles: m.roles,
        nickname: Option.none(),
        display_name: Option.none(),
      })),
    }),
  );

// Shape of the outer RPC result
type RegisterMemberResult = Option.Option<{
  system_log_channel_id: Option.Option<Discord.Snowflake>;
  welcome: Option.Option<{
    welcome_channel_id: Option.Option<Discord.Snowflake>;
    welcome_message_rendered: Option.Option<string>;
    group_name: Option.Option<string>;
    group_color_int: Option.Option<number>;
    inviter_discord_id: Option.Option<Discord.Snowflake>;
  }>;
  invite_code: Option.Option<string>;
}>;

// bug fix-group-channel-discord-join (PR 1) — flattens every `emitMembersAddedBatch` call's
// `entries` across BOTH producers that can call it in the same `Guild/RegisterMember` (the
// pre-existing `applyInviteGroup` emit AND the new `emitMemberGroupChannelRoles` emit), so tests
// can assert "this group id appears exactly once across the whole call" without caring which of
// the two producers emitted it (U4's point exactly).
const emittedBatchEntries = () =>
  channelSyncCalls
    .filter((call) => call.method === 'emitMembersAddedBatch')
    .flatMap(
      (call) =>
        (
          call.args[0] as {
            entries: ReadonlyArray<{
              groupId: string;
              teamMemberId: string;
              discordUserId: string;
            }>;
          }
        ).entries,
    );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Guild/RegisterMember RPC — invite_code handling', () => {
  itEffect.effect(
    'with invite_code: None → returns Some({system_log_channel_id, welcome: None, invite_code: None}), member registered',
    () =>
      callRegisterMember({
        discord_id: '200000000000000001',
        username: 'new-member-1',
        invite_code: Option.none(),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Option.isSome(result)).toBe(true);
            const meta = Option.getOrThrow(result);
            // System log channel always comes through when team is linked
            expect(Option.getOrNull(meta.system_log_channel_id)).toBe(SYSTEM_LOG_CHANNEL_ID);
            // No invite resolved → welcome is None
            expect(Option.isNone(meta.welcome)).toBe(true);
            // invite_code is None because none was provided
            expect(Option.isNone(meta.invite_code)).toBe(true);
            expect(teamMembersAdded.some((m) => m.team_id === TEAM_ID)).toBe(true);
          }),
        ),
      ),
  );

  itEffect.effect(
    'with invite_code: Some(code) where invite has a group → member registered, junction row inserted, RPC returns Some with welcome metadata',
    () =>
      callRegisterMember({
        discord_id: '200000000000000002',
        username: 'new-member-2',
        invite_code: Option.some(VALID_CODE_WITH_GROUP),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Option.isSome(result)).toBe(true);
            const meta = Option.getOrThrow(result);
            expect(Option.getOrNull(meta.system_log_channel_id)).toBe(SYSTEM_LOG_CHANNEL_ID);
            expect(Option.getOrNull(meta.invite_code)).toBe(VALID_CODE_WITH_GROUP);
            expect(Option.isSome(meta.welcome)).toBe(true);
            const welcome = Option.getOrThrow(meta.welcome);
            const rendered = Option.getOrNull(welcome.welcome_message_rendered);
            expect(rendered).toBeTruthy();
            expect(Option.getOrNull(welcome.group_name)).toBe('Strikers');
            expect(Option.getOrNull(welcome.inviter_discord_id)).toBe(INVITER_DISCORD_ID);
            // group junction row should have been inserted
            expect(groupMembersAdded.some((g) => g.group_id === GROUP_ID)).toBe(true);
          }),
        ),
      ),
  );

  itEffect.effect(
    'with invite_code: Some(code) where invite has no group → member registered, no junction row, RPC returns Some with welcome',
    () =>
      callRegisterMember({
        discord_id: '200000000000000003',
        username: 'new-member-3',
        invite_code: Option.some(VALID_CODE_NO_GROUP),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Option.isSome(result)).toBe(true);
            const meta = Option.getOrThrow(result);
            expect(Option.isSome(meta.welcome)).toBe(true);
            const welcome = Option.getOrThrow(meta.welcome);
            expect(Option.isNone(welcome.group_name)).toBe(true);
            expect(groupMembersAdded.length).toBe(0);
          }),
        ),
      ),
  );

  itEffect.effect(
    'with invite_code: Some(NONEXISTENT) → member registered, returns Some with system_log but welcome: None',
    () =>
      callRegisterMember({
        discord_id: '200000000000000004',
        username: 'new-member-4',
        invite_code: Option.some(NONEXISTENT_CODE),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // Member still registered
            expect(teamMembersAdded.some((m) => m.team_id === TEAM_ID)).toBe(true);
            // System log channel still available; welcome is None because code not resolved
            expect(Option.isSome(result)).toBe(true);
            const meta = Option.getOrThrow(result);
            expect(Option.getOrNull(meta.system_log_channel_id)).toBe(SYSTEM_LOG_CHANNEL_ID);
            expect(Option.isNone(meta.welcome)).toBe(true);
            expect(Option.getOrNull(meta.invite_code)).toBe(NONEXISTENT_CODE);
          }),
        ),
      ),
  );

  itEffect.effect(
    'with invite_code: Some(EXPIRED_CODE) → member registered, returns Some with system_log but welcome: None',
    () =>
      callRegisterMember({
        discord_id: '200000000000000005',
        username: 'new-member-5',
        invite_code: Option.some(EXPIRED_CODE),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(teamMembersAdded.some((m) => m.team_id === TEAM_ID)).toBe(true);
            expect(Option.isSome(result)).toBe(true);
            const meta = Option.getOrThrow(result);
            expect(Option.getOrNull(meta.system_log_channel_id)).toBe(SYSTEM_LOG_CHANNEL_ID);
            expect(Option.isNone(meta.welcome)).toBe(true);
          }),
        ),
      ),
  );

  itEffect.effect(
    'with invite_code: Some(code) — member already registered — idempotency no error',
    () =>
      callRegisterMember({
        discord_id: '200000000000000006',
        username: 'new-member-6',
        invite_code: Option.some(VALID_CODE_WITH_GROUP),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // Should not throw; result is defined
            expect(result).toBeDefined();
          }),
        ),
      ),
  );

  itEffect.effect(
    'cross-team invite: invite belongs to different team → no group-add, member registered, returns Some with system_log but welcome: None',
    () =>
      callRegisterMember({
        discord_id: '200000000000000007',
        username: 'new-member-7',
        invite_code: Option.some(CROSS_TEAM_CODE),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // Member still registered to their guild's team
            expect(teamMembersAdded.some((m) => m.team_id === TEAM_ID)).toBe(true);
            // No group junction row because invite belongs to a different team
            expect(groupMembersAdded.length).toBe(0);
            // System log channel still present; welcome is None because cross-team invite rejected
            expect(Option.isSome(result)).toBe(true);
            const meta = Option.getOrThrow(result);
            expect(Option.getOrNull(meta.system_log_channel_id)).toBe(SYSTEM_LOG_CHANNEL_ID);
            expect(Option.isNone(meta.welcome)).toBe(true);
            // invite_code is still captured for the system log
            expect(Option.getOrNull(meta.invite_code)).toBe(CROSS_TEAM_CODE);
          }),
        ),
      ),
  );
});

// ---------------------------------------------------------------------------
// PR-8 — level-based role reconciliation on guild join
// ---------------------------------------------------------------------------

describe('Guild/RegisterMember — PR-8 discord_joined_at (CC-0 / CC-10)', () => {
  itEffect.effect('sets discord_joined_at on first observation when source is Some', () => {
    const discordId = '300000000000000001';
    const memberId = 'member-discord-joined-1' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    return callRegisterMember({
      discord_id: discordId,
      username: 'member-1',
      invite_code: Option.none(),
      source: Option.some('member_add'),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(discordJoinedAt.get(memberId)).toBeInstanceOf(Date);
        }),
      ),
    );
  });

  itEffect.effect('does not overwrite an existing discord_joined_at', () => {
    const discordId = '300000000000000002';
    const memberId = 'member-discord-joined-2' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    const payload = {
      discord_id: discordId,
      username: 'member-2',
      invite_code: Option.none(),
      source: Option.some<'member_add' | 'reconcile'>('member_add'),
    };
    return callRegisterMember(payload).pipe(
      Effect.flatMap(() => {
        const first = discordJoinedAt.get(memberId);
        return callRegisterMember(payload).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const second = discordJoinedAt.get(memberId);
              expect(second).toBe(first);
            }),
          ),
        );
      }),
    );
  });

  itEffect.effect('Guild/RemoveMember clears discord_joined_at', () => {
    const discordId = '300000000000000003';
    const memberId = 'member-discord-joined-3' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    return callRegisterMember({
      discord_id: discordId,
      username: 'member-3',
      invite_code: Option.none(),
      source: Option.some('member_add'),
    }).pipe(
      Effect.flatMap(() => {
        expect(discordJoinedAt.get(memberId)).toBeInstanceOf(Date);
        return callRemoveMember(discordId);
      }),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(discordJoinedAt.get(memberId)).toBeNull();
        }),
      ),
    );
  });

  itEffect.effect('a payload with NO source field sets no timestamp and emits nothing', () => {
    const discordId = '300000000000000004';
    const memberId = 'member-discord-joined-4' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    // Member is missing the Captain role — if the diff ran, this would emit role_assigned.
    return callRegisterMember({
      discord_id: discordId,
      username: 'member-4',
      invite_code: Option.none(),
      roles: [],
      source: Option.none(),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(discordJoinedAt.has(memberId)).toBe(false);
          expect(roleAssignedEvents.length).toBe(0);
          expect(roleUnassignedEvents.length).toBe(0);
        }),
      ),
    );
  });
});

describe('Guild/RegisterMember — PR-8 level-based role diff (CC-10)', () => {
  itEffect.effect(
    'emits role_assigned for each missing mapped role when an already-active member joins the guild',
    () => {
      const discordId = '400000000000000001';
      const memberId = 'member-diff-1' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
      // The reporter's exact case: registered on Sideline already, joins Discord with NO roles.
      return callRegisterMember({
        discord_id: discordId,
        username: 'diff-member-1',
        invite_code: Option.none(),
        roles: [],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleAssignedEvents).toHaveLength(1);
            expect(roleAssignedEvents[0]?.roleId).toBe(CAPTAIN_ROLE_ID);
            expect(roleAssignedEvents[0]?.teamMemberId).toBe(memberId);
            expect(roleAssignedEvents[0]?.discordUserId).toBe(discordId);
            expect(roleUnassignedEvents).toHaveLength(0);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    "emits nothing when the member's Discord roles already match their Sideline roles",
    () => {
      const discordId = '400000000000000002';
      const memberId = 'member-diff-2' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'diff-member-2',
        invite_code: Option.none(),
        roles: [CAPTAIN_DISCORD_ROLE_ID],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleAssignedEvents).toHaveLength(0);
            expect(roleUnassignedEvents).toHaveLength(0);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'emits role_unassigned for a mapped Discord role the member should not have',
    () => {
      const discordId = '400000000000000003';
      const memberId = 'member-diff-3' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      // Desires nothing, but Discord shows them holding the Coach role.
      effectiveRoles.set(memberId, []);
      // Blocker (whole-series review of commit 46806427): the unassign candidate list keys on
      // `member_role_grants`, not merely on the mapping being present — Sideline must have
      // granted THIS member the Coach role for it to be stripped.
      grantedRoleIds.set(memberId, [COACH_ROLE_ID]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'diff-member-3',
        invite_code: Option.none(),
        roles: [COACH_DISCORD_ROLE_ID],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleAssignedEvents).toHaveLength(0);
            expect(roleUnassignedEvents).toHaveLength(1);
            expect(roleUnassignedEvents[0]?.roleId).toBe(COACH_ROLE_ID);
            expect(roleUnassignedEvents[0]?.teamMemberId).toBe(memberId);
          }),
        ),
      );
    },
  );

  itEffect.effect('never emits for a Discord role with no mapping', () => {
    const discordId = '400000000000000004';
    const memberId = 'member-diff-4' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    effectiveRoles.set(memberId, []);
    // Member holds a Discord role Sideline has no mapping for — a captain granted it by hand.
    return callRegisterMember({
      discord_id: discordId,
      username: 'diff-member-4',
      invite_code: Option.none(),
      roles: [UNMANAGED_DISCORD_ROLE_ID],
      source: Option.some('member_add'),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(roleAssignedEvents).toHaveLength(0);
          expect(roleUnassignedEvents).toHaveLength(0);
        }),
      ),
    );
  });

  itEffect.effect('a second identical member_add for the same member emits nothing', () => {
    const discordId = '400000000000000005';
    const memberId = 'member-diff-5' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
    const payload = {
      discord_id: discordId,
      username: 'diff-member-5',
      invite_code: Option.none(),
      roles: [CAPTAIN_DISCORD_ROLE_ID],
      source: Option.some<'member_add' | 'reconcile'>('member_add'),
    };
    return callRegisterMember(payload).pipe(
      Effect.flatMap(() => callRegisterMember(payload)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(roleAssignedEvents).toHaveLength(0);
          expect(roleUnassignedEvents).toHaveLength(0);
        }),
      ),
    );
  });

  itEffect.effect(
    're-running the same reconcile after a simulated MarkEventFailed re-emits the event',
    () => {
      const discordId = '400000000000000006';
      const memberId = 'member-diff-6' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
      const payload = {
        discord_id: discordId,
        username: 'diff-member-6',
        invite_code: Option.none(),
        roles: [],
        source: Option.some<'member_add' | 'reconcile'>('reconcile'),
      };
      return callRegisterMember(payload).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleAssignedEvents).toHaveLength(1);
          }),
        ),
        // Simulate `Role/MarkEventFailed` consuming the just-emitted event — under the old
        // design this permanently stranded the member (blocker 8). The level-based diff has no
        // memory of it: nothing here should suppress the next pass.
        Effect.flatMap(() => Effect.void),
        Effect.flatMap(() => callRegisterMember(payload)),
        Effect.tap(() =>
          Effect.sync(() => {
            // Same missing role, still missing — re-derived, not gated by prior emission or by
            // the queue-consumption event above.
            expect(roleAssignedEvents).toHaveLength(2);
          }),
        ),
      );
    },
  );

  itEffect.effect('still runs setupNewMember for a genuinely new member', () => {
    const discordId = '400000000000000007';
    // No seeded membership — this is a brand-new member.
    return callRegisterMember({
      discord_id: discordId,
      username: 'brand-new-member',
      invite_code: Option.none(),
      roles: [CAPTAIN_DISCORD_ROLE_ID],
      source: Option.some('member_add'),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(teamMembersAdded.some((m) => m.user_id === userIdForDiscordId(discordId))).toBe(
            true,
          );
        }),
      ),
    );
  });
});

describe('Guild/RegisterMember — group-scoped invite binds the group before the role diff (bug 3da93506)', () => {
  itEffect.effect("binds the invite's group before running the role diff", () => {
    const discordId = '700000000000000001';
    return callRegisterMember({
      discord_id: discordId,
      username: 'group-invite-member-1',
      invite_code: Option.some(VALID_CODE_WITH_GROUP),
      roles: [],
      source: Option.some('member_add'),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(callLog).toContain('group-add');
          expect(callLog).toContain('role-diff');
          // `lastIndexOf` vs `indexOf`, deliberately: the property is that EVERY group bind
          // precedes the FIRST diff, not merely that some one did. This payload passes
          // `roles: []` so `setupNewMember`'s channel-mapping-derived `addMemberById` never
          // fires today — but give this test a non-empty `roles` array later and `indexOf`
          // would silently weaken to "some group-add came first" while still passing.
          expect(callLog.lastIndexOf('group-add')).toBeLessThan(callLog.indexOf('role-diff'));
        }),
      ),
    );
  });

  itEffect.effect("emits role_assigned for a Sideline role linked to the invite's group", () => {
    const discordId = '700000000000000002';
    return callRegisterMember({
      discord_id: discordId,
      username: 'group-invite-member-2',
      invite_code: Option.some(VALID_CODE_WITH_GROUP),
      roles: [],
      source: Option.some('member_add'),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(roleAssignedEvents).toHaveLength(1);
          expect(roleAssignedEvents[0]?.roleId).toBe(GROUP_ROLE_ID);
          expect(roleAssignedEvents[0]?.roleName).toBe('Strikers Player');
          expect(roleAssignedEvents[0]?.discordUserId).toBe(discordId);
          expect(roleUnassignedEvents).toHaveLength(0);
        }),
      ),
    );
  });

  itEffect.effect(
    "emits channel-sync member_added for the invite's group and its ancestors",
    () => {
      const discordId = '700000000000000003';
      return callRegisterMember({
        discord_id: discordId,
        username: 'group-invite-member-3',
        invite_code: Option.some(VALID_CODE_WITH_GROUP),
        roles: [],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const memberId = memberships.get(userIdForDiscordId(discordId))?.id;
            expect(memberId).toBeDefined();
            const batches = channelSyncCalls.filter(
              (call) => call.method === 'emitMembersAddedBatch',
            );
            expect(batches).toHaveLength(1);
            const [firstBatch] = batches;
            if (firstBatch == null) throw new Error('unreachable — length asserted above');
            const [batchArg] = firstBatch.args as [
              {
                entries: ReadonlyArray<{
                  groupId: string;
                  teamMemberId: string;
                  discordUserId: string;
                }>;
              },
            ];
            const { entries } = batchArg;
            expect(entries.map((e) => e.groupId)).toEqual([GROUP_ID, PARENT_GROUP_ID]);
            for (const entry of entries) {
              expect(entry.teamMemberId).toBe(memberId);
              expect(entry.discordUserId).toBe(discordId);
            }
          }),
        ),
      );
    },
  );

  itEffect.effect('a cross-team invite code does not fall through to the recency fallback', () => {
    const discordId = '700000000000000004';
    recentAcceptances.set(discordId, VALID_CODE_WITH_GROUP);
    return callRegisterMember({
      discord_id: discordId,
      username: 'cross-team-member',
      invite_code: Option.some(CROSS_TEAM_CODE),
      roles: [],
      source: Option.some('member_add'),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
          const meta = Option.getOrThrow(result);
          expect(Option.isNone(meta.welcome)).toBe(true);
          expect(groupMembersAdded).toHaveLength(0);
          expect(channelSyncCalls.some((call) => call.method === 'emitMembersAddedBatch')).toBe(
            false,
          );
          expect(roleAssignedEvents).toHaveLength(0);
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// bug fix-group-channel-discord-join (PR 1) — a member who accepts a group-scoped invite but
// joins Discord late (past the 15-minute acceptance window) or manually never gets the group's
// Discord channel role, because `applyInviteGroup` only fires when `resolveInviteContext`
// resolves an invite. `emitMemberGroupChannelRoles`, wired into `observeGuildMembership`, runs on
// EVERY `source: member_add` observation — independent of any invite — and grants exactly the
// groups (`GroupsRepository.findActiveGroupsWithAncestorsForMember`) whose OWN Discord role
// (`discord_channel_mappings.discord_role_id`) the member does not yet hold.
// ---------------------------------------------------------------------------
describe('Guild/RegisterMember — group channel role sync on Discord join (bug fix-group-channel-discord-join)', () => {
  itEffect.effect(
    'U1: an already-active member in a mapped group + ancestor gets member_added for both (the reported bug)',
    () => {
      const discordId = '800000000000000001';
      const memberId = 'member-channel-u1' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'u1-member',
        invite_code: Option.none(),
        roles: [],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const batches = channelSyncCalls.filter(
              (call) => call.method === 'emitMembersAddedBatch',
            );
            expect(batches).toHaveLength(1);
            const entries = emittedBatchEntries();
            expect(entries.map((e) => e.groupId).sort()).toEqual(
              [GROUP_ID, PARENT_GROUP_ID].sort(),
            );
            for (const entry of entries) {
              expect(entry.teamMemberId).toBe(memberId);
              expect(entry.discordUserId).toBe(discordId);
            }
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U2: steady state — member already holds every mapped role, nothing emits',
    () => {
      const discordId = '800000000000000002';
      const memberId = 'member-channel-u2' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'u2-member',
        invite_code: Option.none(),
        roles: [GROUP_CHANNEL_ROLE_ID, PARENT_CHANNEL_ROLE_ID],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedBatchEntries()).toHaveLength(0);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U3: partial — member holds the group role but not the ancestor role, only the ancestor emits',
    () => {
      const discordId = '800000000000000003';
      const memberId = 'member-channel-u3' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'u3-member',
        invite_code: Option.none(),
        roles: [GROUP_CHANNEL_ROLE_ID],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const entries = emittedBatchEntries();
            expect(entries).toHaveLength(1);
            expect(entries[0]?.groupId).toBe(PARENT_GROUP_ID);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U4: no double-emit — an in-window group-scoped invite for a group the member is already in emits each group exactly once total',
    () => {
      const discordId = '800000000000000004';
      const memberId = 'member-channel-u4' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      // "Already in G" — the member's desired-groups walk resolves to G + its active ancestor P
      // independent of what this call's invite does.
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'u4-member',
        invite_code: Option.some(VALID_CODE_WITH_GROUP),
        roles: [],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // `applyInviteGroup` emits {G, P} once via its own `boundGroupIds`;
            // `emitMemberGroupChannelRoles` must subtract that same set from its own desired
            // list, or G/P would be double-emitted here.
            const entries = emittedBatchEntries();
            expect(entries).toHaveLength(2);
            expect(entries.map((e) => e.groupId).sort()).toEqual(
              [GROUP_ID, PARENT_GROUP_ID].sort(),
            );
          }),
        ),
      );
    },
  );

  itEffect.effect('U5: an unmapped group is skipped entirely', () => {
    const discordId = '800000000000000005';
    const memberId = 'member-channel-u5' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    desiredGroupsByMember.set(memberId, [{ id: UNMAPPED_GROUP_ID, name: 'Unmapped' }]);
    // No `discordChannelMappings` row for UNMAPPED_GROUP_ID at all — the default state only
    // covers GROUP_ID/PARENT_GROUP_ID.
    return callRegisterMember({
      discord_id: discordId,
      username: 'u5-member',
      invite_code: Option.none(),
      roles: [],
      source: Option.some('member_add'),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedBatchEntries()).toHaveLength(0);
        }),
      ),
    );
  });

  // Load-bearing (inverted from an earlier draft): a `discord_channel_mappings` row with
  // `discord_role_id: None` must be SKIPPED, exactly like no row at all. Emitting for it would
  // let the bot's `handleMemberAdded.ts:53-64` `createRoleOnly(guild_id, group_name)` branch
  // create a raw-named, colourless Discord role — which then makes the group invisible to
  // `findGroupsMissingRole` (`m.discord_role_id IS NOT NULL` in its own predicate) FOREVER.
  itEffect.effect(
    'U6: a role-less mapping is skipped — no member_added entry is emitted for its group',
    () => {
      const discordId = '800000000000000006';
      const memberId = 'member-channel-u6' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      desiredGroupsByMember.set(memberId, [{ id: UNMAPPED_GROUP_ID, name: 'RoleLess' }]);
      discordChannelMappings.push({
        group_id: Option.some(UNMAPPED_GROUP_ID),
        discord_channel_id: Option.some(GROUP_CHANNEL_DISCORD_ID),
        discord_role_id: Option.none(),
      });
      return callRegisterMember({
        discord_id: discordId,
        username: 'u6-member',
        invite_code: Option.none(),
        roles: [],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // No entry whatsoever for this group — the whole point is that NOTHING reaches the
            // bot's `createRoleOnly` branch, and a member_added row is the only thing that could
            // ever trigger it.
            expect(emittedBatchEntries().some((e) => e.groupId === UNMAPPED_GROUP_ID)).toBe(false);
            expect(emittedBatchEntries()).toHaveLength(0);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U7: a mapping with a cleared channel but an intact role still emits — we key on the role',
    () => {
      const discordId = '800000000000000007';
      const memberId = 'member-channel-u7' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      desiredGroupsByMember.set(memberId, [{ id: UNMAPPED_GROUP_ID, name: 'ChannelCleared' }]);
      discordChannelMappings.push({
        group_id: Option.some(UNMAPPED_GROUP_ID),
        discord_channel_id: Option.none(),
        discord_role_id: Option.some(GROUP_CHANNEL_ROLE_ID),
      });
      return callRegisterMember({
        discord_id: discordId,
        username: 'u7-member',
        invite_code: Option.none(),
        roles: [],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const entries = emittedBatchEntries();
            expect(entries).toHaveLength(1);
            expect(entries[0]?.groupId).toBe(UNMAPPED_GROUP_ID);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U8: an unmanaged Discord role the member happens to hold is inert — G still emits, and nothing is ever removed',
    () => {
      const discordId = '800000000000000008';
      const memberId = 'member-channel-u8' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      // Deliberately only G, no ancestor — isolates "does an unrelated held role confuse the
      // diff" from ancestor-walk behaviour, which U1/U3/U4 already cover.
      desiredGroupsByMember.set(memberId, [{ id: GROUP_ID, name: 'Strikers' }]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'u8-member',
        invite_code: Option.none(),
        roles: [UNMANAGED_DISCORD_ROLE_ID],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const entries = emittedBatchEntries();
            expect(entries).toHaveLength(1);
            expect(entries[0]?.groupId).toBe(GROUP_ID);
            expect(channelSyncCalls.some((call) => call.method === 'emitMembersRemovedBatch')).toBe(
              false,
            );
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U9: a payload with no source (pre-PR-8 bot) emits nothing, even with groups pending',
    () => {
      const discordId = '800000000000000009';
      const memberId = 'member-channel-u9' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      // If the `source` gate were broken, this would emit for both — giving the assertion teeth.
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      return callRegisterMember({
        discord_id: discordId,
        username: 'u9-member',
        invite_code: Option.none(),
        roles: [],
        source: Option.none(),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedBatchEntries()).toHaveLength(0);
            expect(discordJoinedAt.get(memberId)).toBeUndefined();
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U11: a redelivered dispatch converges — the second identical member_add emits nothing new',
    () => {
      const discordId = '800000000000000011';
      const memberId = 'member-channel-u11' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      const payloadBase = {
        discord_id: discordId,
        username: 'u11-member',
        invite_code: Option.none(),
        source: Option.some<'member_add' | 'reconcile'>('member_add'),
      };
      return callRegisterMember({ ...payloadBase, roles: [] }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedBatchEntries()).toHaveLength(2);
          }),
        ),
        Effect.flatMap(() =>
          callRegisterMember({
            ...payloadBase,
            roles: [GROUP_CHANNEL_ROLE_ID, PARENT_CHANNEL_ROLE_ID],
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            // Still 2 — Discord now reports both roles held, so the second dispatch adds
            // nothing new, it does not double what the first call already emitted.
            expect(emittedBatchEntries()).toHaveLength(2);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U12: per-member emission cap — 40 mapped, unheld groups still emit at most 25',
    () => {
      const discordId = '800000000000000012';
      const memberId = 'member-channel-u12' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      const groups = Array.from({ length: 40 }, (_, i) => {
        const groupId =
          `00000000-0000-0000-0001-${String(i).padStart(12, '0')}` as GroupModel.GroupId;
        const roleId = `61${String(i).padStart(16, '0')}` as Discord.Snowflake;
        discordChannelMappings.push({
          group_id: Option.some(groupId),
          discord_channel_id: Option.some(`62${String(i).padStart(16, '0')}` as Discord.Snowflake),
          discord_role_id: Option.some(roleId),
        });
        return { id: groupId, name: `Cap Group ${i}` };
      });
      desiredGroupsByMember.set(memberId, groups);
      return callRegisterMember({
        discord_id: discordId,
        username: 'u12-member',
        invite_code: Option.none(),
        roles: [],
        source: Option.some('member_add'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER = 25.
            expect(emittedBatchEntries().length).toBeLessThanOrEqual(25);
            expect(emittedBatchEntries()).toHaveLength(25);
          }),
        ),
      );
    },
  );
});

describe('Guild/ReconcileMembers — PR-8 level-based reconcile (CC-10)', () => {
  itEffect.effect('does not emit role_assigned events in steady state', () => {
    const discordId = '500000000000000001';
    const memberId = 'member-reconcile-steady' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
    return callReconcileMembers(
      [{ discord_id: discordId, username: 'steady-member', roles: [CAPTAIN_DISCORD_ROLE_ID] }],
      true,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(roleAssignedEvents).toHaveLength(0);
          expect(roleUnassignedEvents).toHaveLength(0);
        }),
      ),
    );
  });

  // bug fix-group-channel-discord-join (PR 1) — U10, a regression guard: `emitMemberGroupChannelRoles`
  // must run ONLY when `payload.source` is `Some('member_add')`. `Guild/ReconcileMembers` always
  // supplies `Some('reconcile')` (see the server-side comment at the RPC handler), so it must emit
  // NOTHING here, regardless of `complete` — the reconcile path is deliberately left uncovered by
  // this PR (see `AGENTS.md`'s accepted-gap note) to avoid the N+1 fan-out §2 of the plan rejects.
  itEffect.effect(
    'U10a: Guild/ReconcileMembers emits no channel-sync member_added, with complete: true',
    () => {
      const discordId = '800000000000000010';
      const memberId = 'member-channel-u10a' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      // Pending groups the member does NOT yet hold the role for — if the gate were broken,
      // this would emit.
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      return callReconcileMembers(
        [{ discord_id: discordId, username: 'u10a-member', roles: [] }],
        true,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedBatchEntries()).toHaveLength(0);
            expect(discordJoinedAt.get(memberId)).toBeInstanceOf(Date);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'U10b: Guild/ReconcileMembers emits no channel-sync member_added, with complete: false',
    () => {
      const discordId = '800000000000000013';
      const memberId = 'member-channel-u10b' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      desiredGroupsByMember.set(memberId, [
        { id: GROUP_ID, name: 'Strikers' },
        { id: PARENT_GROUP_ID, name: 'Seniors' },
      ]);
      return callReconcileMembers(
        [{ discord_id: discordId, username: 'u10b-member', roles: [] }],
        false,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(emittedBatchEntries()).toHaveLength(0);
            expect(discordJoinedAt.has(memberId)).toBe(false);
          }),
        ),
      );
    },
  );

  itEffect.effect('with complete: false runs the diff but sets no discord_joined_at', () => {
    const discordId = '500000000000000002';
    const memberId = 'member-reconcile-partial' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
    return callReconcileMembers(
      [{ discord_id: discordId, username: 'partial-member', roles: [] }],
      false,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(roleAssignedEvents).toHaveLength(1);
          expect(discordJoinedAt.has(memberId)).toBe(false);
          expect(markMembersBackfilledCalls).toHaveLength(0);
        }),
      ),
    );
  });

  itEffect.effect(
    'with complete: true sets discord_joined_at and bot_guilds.members_backfilled_at',
    () => {
      const discordId = '500000000000000003';
      const memberId = 'member-reconcile-complete' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
      return callReconcileMembers(
        [{ discord_id: discordId, username: 'complete-member', roles: [] }],
        true,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleAssignedEvents).toHaveLength(1);
            expect(discordJoinedAt.get(memberId)).toBeInstanceOf(Date);
            expect(markMembersBackfilledCalls).toEqual([GUILD_ID]);
          }),
        ),
      );
    },
  );

  itEffect.effect(
    'stops emitting at the per-guild cap and logs how many members were skipped',
    () => {
      // MAX_ROLE_SYNC_EMISSIONS_PER_GUILD_RECONCILE is 200 — 201 members each missing exactly
      // one mapped role guarantees exactly 1 is deferred to the next pass.
      const CAP = 200;
      const members = Array.from({ length: CAP + 1 }, (_, i) => {
        const discordId = `60000000000000${String(i).padStart(4, '0')}`;
        const memberId = `member-cap-${i}` as TeamMember.TeamMemberId;
        seedActiveMember(discordId, memberId);
        effectiveRoles.set(memberId, [{ role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' }]);
        return { discord_id: discordId, username: `cap-member-${i}`, roles: [] };
      });
      return callReconcileMembers(members, true).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleAssignedEvents).toHaveLength(CAP);
          }),
        ),
      );
    },
  );

  // Blocker (whole-series review of commit 46806427): PR-8's level-based diff computes
  // `unassignCandidates` from EVERY managed mapping present in `actual` and absent from
  // `desired` AND recorded as granted to this member in `member_role_grants` — NOT merely from
  // "not `adopted`" (`46806427`'s original, overshooting fix). A member holding a hand-made,
  // adopted Discord role Sideline never granted THEM (no `member_role_grants` row for this
  // member+role) must never get `role_unassigned` -> `deleteGuildMemberRole` — that is the
  // destruction of human-managed state `handleDeleted.ts` and the `adopted` column exist to
  // prevent.
  itEffect.effect(
    'never emits role_unassigned for an adopted mapping the member holds but Sideline never granted THEM',
    () => {
      const discordId = '500000000000000004';
      const memberId = 'member-reconcile-adopted' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      // Desires nothing — no `member_roles` row for the adopted role — but Discord shows them
      // holding it (a captain granted it by hand before Sideline adopted the mapping). No
      // `member_role_grants` row either — Sideline never gave THIS member the role.
      effectiveRoles.set(memberId, []);
      return callReconcileMembers(
        [{ discord_id: discordId, username: 'adopted-member', roles: [ADOPTED_DISCORD_ROLE_ID] }],
        true,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleUnassignedEvents).toHaveLength(0);
            expect(roleAssignedEvents).toHaveLength(0);
          }),
        ),
      );
    },
  );

  // The other half of the blocker fix: an adopted mapping Sideline itself GRANTED to this member
  // (a `member_role_grants` row exists) is no longer protected just because the mapping is
  // `adopted: true` — provenance is per-member, not per-mapping. This is what lets a member
  // demoted out of an adopted role (e.g. a group-detach) actually lose Discord access, instead
  // of keeping it forever the way `46806427`'s blanket `!adopted` exclusion left them.
  itEffect.effect(
    'emits role_unassigned for an adopted mapping Sideline itself granted to this member',
    () => {
      const discordId = '500000000000000006';
      const memberId = 'member-reconcile-adopted-granted' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      effectiveRoles.set(memberId, []);
      grantedRoleIds.set(memberId, [ADOPTED_ROLE_ID]);
      return callReconcileMembers(
        [
          {
            discord_id: discordId,
            username: 'adopted-member-granted',
            roles: [ADOPTED_DISCORD_ROLE_ID],
          },
        ],
        true,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleUnassignedEvents).toHaveLength(1);
            expect(roleUnassignedEvents[0]?.roleId).toBe(ADOPTED_ROLE_ID);
            expect(roleUnassignedEvents[0]?.teamMemberId).toBe(memberId);
          }),
        ),
      );
    },
  );

  // bug 3da93506: `assignCandidates` used to be filtered from `managed` (existing
  // `discord_role_mappings` rows), so a Sideline role that had never been mapped could never be
  // provisioned by this automatic path at all — only by the manual "sync roles" button, which
  // emits from `desired` directly. The bot's `handleMemberAdded` calls `ensureMapping`
  // (adopt-or-create) before assigning, so an unmapped role is provisionable, not unknown.
  itEffect.effect('emits role_assigned for a desired role that has no mapping yet', () => {
    const discordId = '500000000000000007';
    const memberId = 'member-reconcile-unmapped' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    effectiveRoles.set(memberId, [{ role_id: UNMAPPED_ROLE_ID, role_name: 'Brand New' }]);
    return callReconcileMembers(
      [{ discord_id: discordId, username: 'unmapped-role-member', roles: [] }],
      true,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(roleAssignedEvents).toHaveLength(1);
          expect(roleAssignedEvents[0]?.roleId).toBe(UNMAPPED_ROLE_ID);
          // The name rides along from `desired` (`effectiveRolesFrom`), not from a
          // `findRoleById` lookup — `UNMAPPED_ROLE_ID` is not in `MockRolesRepository` at all.
          expect(roleAssignedEvents[0]?.roleName).toBe('Brand New');
          // The anti-stripping guard (CC-8) is untouched: it lives on `unassignCandidates`,
          // which is still filtered from `managed`.
          expect(roleUnassignedEvents).toHaveLength(0);
        }),
      ),
    );
  });

  // The other side of the same change: widening assignment to `desired` must not re-emit for a
  // role the member already holds, or steady state would flood the queue every pass.
  itEffect.effect('still emits nothing for a mapped role the member already holds', () => {
    const discordId = '500000000000000008';
    const memberId = 'member-reconcile-unmapped-steady' as TeamMember.TeamMemberId;
    seedActiveMember(discordId, memberId);
    effectiveRoles.set(memberId, [
      { role_id: CAPTAIN_ROLE_ID, role_name: 'Captain' },
      { role_id: UNMAPPED_ROLE_ID, role_name: 'Brand New' },
    ]);
    return callReconcileMembers(
      [
        {
          discord_id: discordId,
          username: 'unmapped-steady-member',
          roles: [CAPTAIN_DISCORD_ROLE_ID],
        },
      ],
      true,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // Only the still-unmapped role — the mapped-and-held Captain role is not re-emitted.
          expect(roleAssignedEvents).toHaveLength(1);
          expect(roleAssignedEvents[0]?.roleId).toBe(UNMAPPED_ROLE_ID);
          expect(roleUnassignedEvents).toHaveLength(0);
        }),
      ),
    );
  });

  // Symmetric with the above: an adopted mapping is still eligible to be ADDED — only stripping
  // is forbidden.
  itEffect.effect(
    'still emits role_assigned for an adopted mapping the member newly desires',
    () => {
      const discordId = '500000000000000005';
      const memberId = 'member-reconcile-adopted-add' as TeamMember.TeamMemberId;
      seedActiveMember(discordId, memberId);
      effectiveRoles.set(memberId, [{ role_id: ADOPTED_ROLE_ID, role_name: 'Adopted' }]);
      return callReconcileMembers(
        [{ discord_id: discordId, username: 'adopted-member-add', roles: [] }],
        true,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(roleAssignedEvents).toHaveLength(1);
            expect(roleAssignedEvents[0]?.roleId).toBe(ADOPTED_ROLE_ID);
            expect(roleUnassignedEvents).toHaveLength(0);
          }),
        ),
      );
    },
  );
});
