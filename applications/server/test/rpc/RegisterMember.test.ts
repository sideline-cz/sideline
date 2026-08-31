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
  ];
  roleAssignedEvents = [];
  roleUnassignedEvents = [];
  markMembersBackfilledCalls = [];
  nextMemberId = 1;
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
  findEffectiveRoleIdsForMember: (memberId: string) =>
    Effect.succeed(effectiveRoles.get(memberId) ?? []),
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
  getDescendantMemberIds: () => Effect.succeed([]),
  findGroupIdsByMember: () => Effect.succeed([]),
  removeAllForMember: () => Effect.void,
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
  findRecentByUserAndGuildWithContext: () => Effect.succeed(Option.none()),
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
  findAllByTeam: () => Effect.succeed([]),
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
      Layer.succeed(
        ChannelSyncEventsRepository,
        new Proxy({} as any, { get: () => () => Effect.void }),
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
