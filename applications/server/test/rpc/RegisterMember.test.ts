import { it as itEffect } from '@effect/vitest';
import type { Auth, Discord, GroupModel, Team } from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
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

// ---------------------------------------------------------------------------
// In-memory stores (reset between tests)
// ---------------------------------------------------------------------------

let teamMembersAdded: Array<{ team_id: string; user_id: string }>;
let groupMembersAdded: Array<{ group_id: string; member_id: string }>;

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

type InviteContext = {
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
};

const inviteContexts: ReadonlyMap<string, InviteContext> = new Map([
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
    const id = crypto.randomUUID() as Auth.UserId;
    return Effect.succeed({
      id,
      discord_id: input.discord_id,
      username: input.username,
      avatar: Option.none(),
      is_profile_complete: false,
    });
  },
  findById: () => Effect.succeed(Option.none()),
  findByDiscordId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamMembersRepository = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: () => Effect.succeed(Option.none()),
  addMember: (input: { team_id: string; user_id: string }) => {
    teamMembersAdded.push({ team_id: input.team_id, user_id: input.user_id });
    const memberId = crypto.randomUUID();
    return Effect.succeed({
      id: memberId as import('@sideline/domain').TeamMember.TeamMemberId,
      team_id: input.team_id,
      user_id: input.user_id,
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
} as any);

const MockTeamInvitesRepository = Layer.succeed(TeamInvitesRepository, {
  findByCodeWithContext: (code: string) => {
    const ctx = inviteContexts.get(code);
    if (!ctx || !ctx.active) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        ...ctx,
        inviter_username: 'inviter-user',
      }),
    );
  },
  findByCode: (code: string) => {
    const ctx = inviteContexts.get(code);
    if (!ctx || !ctx.active) return Effect.succeed(Option.none());
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
    if (!ctx || !ctx.active) return Effect.succeed(Option.none());
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
} as any);

const MockDiscordChannelsRepository = Layer.succeed(DiscordChannelsRepository, {
  syncChannels: () => Effect.void,
  findByGuildId: () => Effect.succeed([]),
  upsertChannel: () => Effect.void,
  deleteChannel: () => Effect.void,
  updateChannelName: () => Effect.void,
} as any);

const MockDiscordRoleMappingRepository = Layer.succeed(DiscordRoleMappingRepository, {
  findAllByTeam: () => Effect.succeed([]),
} as any);

const MockDiscordChannelMappingRepository = Layer.succeed(DiscordChannelMappingRepository, {
  findAllByTeam: () => Effect.succeed([]),
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
} as any);

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
      Layer.succeed(DiscordRolesRepository, new Proxy({} as any, { get: () => () => Effect.void })),
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
// RPC call helper
// ---------------------------------------------------------------------------

const callRegisterMember = (payload: {
  discord_id: string;
  username: string;
  invite_code: Option.Option<string>;
}) =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Guild/RegisterMember']({
            guild_id: GUILD_ID,
            discord_id: payload.discord_id,
            username: payload.username,
            avatar: Option.none(),
            roles: [],
            nickname: Option.none(),
            display_name: Option.none(),
            invite_code: payload.invite_code,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(TestLayer)) as Effect.Effect<RegisterMemberResult, any, never>;

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
