import {
  type Discord,
  type GroupModel,
  GuildRpcGroup,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { applyTemplate, sanitizeHexColor, sanitizeRendered } from '@sideline/template-renderer';
import { Array, Effect, Option, pipe } from 'effect';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

type RegisterMemberPayload = {
  readonly guild_id: Discord.Snowflake;
  readonly discord_id: string;
  readonly username: string;
  readonly avatar: Option.Option<string>;
  readonly roles: ReadonlyArray<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly invite_code: Option.Option<string>;
};

type WelcomeDetail = {
  readonly welcome_channel_id: Option.Option<Discord.Snowflake>;
  readonly welcome_message_rendered: Option.Option<string>;
  readonly group_name: Option.Option<string>;
  readonly group_color_int: Option.Option<number>;
  readonly inviter_discord_id: Option.Option<Discord.Snowflake>;
};

type WelcomeMeta = {
  readonly system_log_channel_id: Option.Option<Discord.Snowflake>;
  readonly welcome: Option.Option<WelcomeDetail>;
  readonly invite_code: Option.Option<string>;
};

export const GuildsRpcLive = Effect.Do.pipe(
  Effect.bind('botGuilds', () => BotGuildsRepository.asEffect()),
  Effect.bind('discordChannels', () => DiscordChannelsRepository.asEffect()),
  Effect.bind('discordRoles', () => DiscordRolesRepository.asEffect()),
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('roleMappings', () => DiscordRoleMappingRepository.asEffect()),
  Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
  Effect.bind('groups', () => GroupsRepository.asEffect()),
  Effect.bind('acceptances', () => InviteAcceptancesRepository.asEffect()),
  Effect.bind('pendingGuildJoins', () => PendingGuildJoinsRepository.asEffect()),
  Effect.map((deps) => {
    const setupNewMember = (
      team: { readonly id: Team.TeamId },
      newMember: { readonly id: TeamMember.TeamMemberId },
      roles: ReadonlyArray<string>,
    ) =>
      Effect.Do.pipe(
        Effect.tap(() =>
          deps.members.getPlayerRoleId(team.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.logInfo('No Player role found, skipping'),
                onSome: (playerRole) => deps.members.assignRole(newMember.id, playerRole.id),
              }),
            ),
          ),
        ),
        Effect.tap(() =>
          deps.roleMappings.findAllByTeam(team.id).pipe(
            Effect.flatMap((mappings) =>
              Effect.all(
                pipe(
                  mappings,
                  Array.filter((m) => roles.includes(m.discord_role_id)),
                  Array.map((m) => deps.members.assignRole(newMember.id, m.role_id)),
                ),
                { concurrency: 'unbounded' },
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          deps.channelMappings.findAllByTeam(team.id).pipe(
            Effect.flatMap((mappings) =>
              Effect.all(
                pipe(
                  mappings,
                  Array.flatMap((m) =>
                    Option.toArray(
                      Option.flatMap(m.discord_role_id, (roleId) =>
                        roles.includes(roleId) ? m.group_id : Option.none(),
                      ),
                    ),
                  ),
                  Array.map((groupId) => deps.groups.addMemberById(groupId, newMember.id)),
                ),
                { concurrency: 'unbounded' },
              ),
            ),
          ),
        ),
      );

    const resolveWelcomeMeta = (
      team: {
        readonly id: Team.TeamId;
        readonly welcome_channel_id: Option.Option<Discord.Snowflake>;
        readonly system_log_channel_id: Option.Option<Discord.Snowflake>;
        readonly welcome_message_template: Option.Option<string>;
      },
      newMember: { readonly id: TeamMember.TeamMemberId },
      payload: RegisterMemberPayload,
    ): Effect.Effect<WelcomeMeta> => {
      const noWelcome: WelcomeMeta = {
        system_log_channel_id: team.system_log_channel_id,
        welcome: Option.none(),
        invite_code: payload.invite_code,
      };
      type Ctx = {
        readonly team_id: Team.TeamId;
        readonly group_id: Option.Option<GroupModel.GroupId>;
        readonly group_name: Option.Option<string>;
        readonly inviter_username: string;
        readonly inviter_discord_id: Option.Option<Discord.Snowflake>;
        readonly team_name: string;
      };
      const buildWelcome = (ctx: Ctx): Effect.Effect<WelcomeMeta> => {
        if (ctx.team_id !== team.id) {
          return Effect.logError(
            `RegisterMember: invite team_id ${ctx.team_id} !== team ${team.id}`,
          ).pipe(Effect.as(noWelcome));
        }
        const renderedMessage = Option.map(team.welcome_message_template, (template) =>
          sanitizeRendered(
            applyTemplate(template, {
              memberMention: `<@${payload.discord_id}>`,
              memberName: Option.getOrElse(payload.display_name, () => payload.username),
              inviterMention: Option.match(ctx.inviter_discord_id, {
                onNone: () => '',
                onSome: (id) => `<@${id}>`,
              }),
              inviterName: ctx.inviter_username,
              groupName: Option.getOrElse(ctx.group_name, () => ''),
              teamName: ctx.team_name,
            }),
          ),
        );
        const fetchGroupColor = Option.match(ctx.group_id, {
          onNone: () => Effect.succeed(Option.none<number>()),
          onSome: (groupId) =>
            deps.groups
              .findGroupById(groupId)
              .pipe(
                Effect.map(
                  Option.flatMap((g) =>
                    Option.fromNullishOr(sanitizeHexColor(Option.getOrNull(g.color))),
                  ),
                ),
              ),
        });
        return Effect.Do.pipe(
          Effect.tap(() =>
            Option.match(ctx.group_id, {
              onNone: () => Effect.void,
              onSome: (groupId) => deps.groups.addMemberById(groupId, newMember.id),
            }),
          ),
          Effect.bind('group_color_int', () => fetchGroupColor),
          Effect.map(
            ({ group_color_int }): WelcomeMeta => ({
              system_log_channel_id: team.system_log_channel_id,
              invite_code: payload.invite_code,
              welcome: Option.some<WelcomeDetail>({
                welcome_channel_id: team.welcome_channel_id,
                welcome_message_rendered: renderedMessage,
                group_name: ctx.group_name,
                group_color_int,
                inviter_discord_id: ctx.inviter_discord_id,
              }),
            }),
          ),
        );
      };
      // Fallback used when the bot couldn't identify the consumed invite code
      // (Discord auto-deletes max_uses:1 invites on consumption, breaking diff matching).
      const fallbackByUserAndGuild = deps.acceptances
        .findRecentByUserAndGuildWithContext(payload.discord_id, payload.guild_id)
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(noWelcome),
              onSome: buildWelcome,
            }),
          ),
        );
      return Option.match(payload.invite_code, {
        onNone: () => fallbackByUserAndGuild,
        onSome: (code) =>
          deps.acceptances.findByDiscordCodeWithContext(code).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.logWarning(
                    `RegisterMember: invite code ${code} not found or expired; trying recency fallback`,
                  ).pipe(Effect.andThen(fallbackByUserAndGuild)),
                onSome: buildWelcome,
              }),
            ),
          ),
      });
    };

    const registerMember = (payload: RegisterMemberPayload) =>
      deps.teams.findByGuildId(payload.guild_id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logInfo(
                `No team found for guild ${payload.guild_id}, skipping member registration`,
              ).pipe(Effect.as(Option.none<WelcomeMeta>())),
            onSome: (team) =>
              Effect.Do.pipe(
                Effect.bind('user', () =>
                  deps.users.upsertFromDiscord({
                    discord_id: payload.discord_id,
                    username: payload.username,
                    avatar: payload.avatar,
                    discord_nickname: payload.nickname,
                    discord_display_name: payload.display_name,
                  }),
                ),
                Effect.bind('existingMembership', ({ user }) =>
                  deps.members.findMembershipByIds(team.id, user.id, { includeInactive: true }),
                ),
                Effect.bind('newMember', ({ existingMembership, user }) => {
                  if (Option.isSome(existingMembership) && existingMembership.value.active) {
                    return Effect.logInfo(
                      `Member ${payload.username} already active in team ${team.id}`,
                    ).pipe(Effect.as({ id: existingMembership.value.id }));
                  }
                  const resolveMemberId = Option.isNone(existingMembership)
                    ? deps.members
                        .addMember({
                          team_id: team.id,
                          user_id: user.id,
                          active: true,
                          joined_at: undefined,
                        })
                        .pipe(Effect.map((m) => ({ id: m.id })))
                    : deps.members
                        .reactivateMember(existingMembership.value.id)
                        .pipe(Effect.map((m) => ({ id: m.id })));
                  return resolveMemberId.pipe(
                    Effect.tap((newMember) => setupNewMember(team, newMember, payload.roles)),
                    Effect.tap(() =>
                      Effect.logInfo(`Registered member ${payload.username} in team ${team.id}`),
                    ),
                  );
                }),
                Effect.flatMap(({ newMember }) => resolveWelcomeMeta(team, newMember, payload)),
                Effect.map(Option.some),
              ),
          }),
        ),
        Effect.catchTag(['MemberAlreadyExistsError', 'NoSuchElementError'], (error) =>
          Effect.logError(`RegisterMember failed for ${payload.username}`, error).pipe(
            Effect.as(Option.none<WelcomeMeta>()),
          ),
        ),
      );

    return {
      'Guild/RegisterGuild': ({
        guild_id,
        guild_name,
        is_community_enabled,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly guild_name: string;
        readonly is_community_enabled: boolean;
      }) => deps.botGuilds.upsert(guild_id, guild_name, is_community_enabled),

      'Guild/UnregisterGuild': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.botGuilds.remove(guild_id),

      'Guild/IsGuildRegistered': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.botGuilds.exists(guild_id),

      'Guild/SyncGuildChannels': ({
        guild_id,
        channels,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channels: ReadonlyArray<{
          readonly channel_id: Discord.Snowflake;
          readonly name: string;
          readonly type: number;
          readonly parent_id: Option.Option<Discord.Snowflake>;
        }>;
      }) => deps.discordChannels.syncChannels(guild_id, channels),

      'Guild/UpdateChannelName': ({
        channel_id,
        name,
      }: {
        readonly channel_id: Discord.Snowflake;
        readonly name: string;
      }) => deps.discordChannels.updateChannelName(channel_id, name),

      'Guild/UpsertChannel': ({
        guild_id,
        channel_id,
        name,
        type,
        parent_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channel_id: Discord.Snowflake;
        readonly name: string;
        readonly type: number;
        readonly parent_id: Option.Option<Discord.Snowflake>;
      }) => deps.discordChannels.upsertChannel(guild_id, channel_id, name, type, parent_id),

      'Guild/DeleteChannel': ({
        guild_id,
        channel_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channel_id: Discord.Snowflake;
      }) => deps.discordChannels.deleteChannel(guild_id, channel_id),

      'Guild/RegisterMember': registerMember,

      'Guild/ReconcileMembers': ({
        guild_id,
        members: membersList,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly members: ReadonlyArray<{
          readonly discord_id: string;
          readonly username: string;
          readonly avatar: Option.Option<string>;
          readonly roles: ReadonlyArray<string>;
          readonly nickname: Option.Option<string>;
          readonly display_name: Option.Option<string>;
        }>;
      }) =>
        Effect.Do.pipe(
          Effect.tap(() =>
            Effect.logInfo(`Reconciling ${membersList.length} members for guild ${guild_id}`),
          ),
          Effect.tap(() =>
            Effect.all(
              Array.map(membersList, (member) =>
                registerMember({
                  guild_id,
                  discord_id: member.discord_id,
                  username: member.username,
                  avatar: member.avatar,
                  roles: member.roles,
                  nickname: member.nickname,
                  display_name: member.display_name,
                  invite_code: Option.none(),
                }),
              ),
              { concurrency: 5 },
            ),
          ),
          Effect.tap(() => Effect.logInfo(`Reconciliation complete for guild ${guild_id}`)),
          Effect.asVoid,
        ),

      'Guild/PendingGuildJoins': () => deps.pendingGuildJoins.listPending(),

      'Guild/MarkGuildJoinDone': ({ id }: { readonly id: string }) =>
        deps.pendingGuildJoins.markDone(id),

      'Guild/MarkGuildJoinFailed': ({
        id,
        error,
      }: {
        readonly id: string;
        readonly error: string;
      }) => deps.pendingGuildJoins.markFailed(id, error),

      'Guild/PendingOnboardingSyncs': ({ limit }: { readonly limit: number }) =>
        deps.teams.claimPendingOnboardingSyncs(limit),

      'Guild/MarkOnboardingSyncDone': ({
        team_id,
        prompt_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly prompt_id: Option.Option<Discord.Snowflake>;
      }) =>
        deps.teams
          .markOnboardingSyncDoneIfSyncing(team_id, prompt_id)
          .pipe(Effect.map((updated) => ({ updated }))),

      'Guild/MarkOnboardingSyncFailed': ({
        team_id,
        error_code,
        error_detail,
      }: {
        readonly team_id: Team.TeamId;
        readonly error_code: string;
        readonly error_detail: string;
      }) =>
        deps.teams
          .markOnboardingSyncFailedIfSyncing(
            team_id,
            JSON.stringify({ code: error_code, detail: error_detail }),
          )
          .pipe(Effect.map(() => ({ updated: true }))),

      'Guild/RevertOnboardingSync': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.teams.revertOnboardingSyncIfSyncing(team_id),

      'Guild/MarkOnboardingSyncSkipped': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.teams.markOnboardingSyncSkippedIfSyncing(team_id),

      'Guild/SetOverviewChannel': ({
        guild_id,
        channel_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channel_id: Discord.Snowflake;
      }) =>
        deps.teams.setOverviewChannelByGuildId(guild_id, channel_id).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.void
              : // Channel actually changed — re-trigger welcome-screen sync.
                Effect.all(
                  Array.map(rows, (row) => deps.teams.markOnboardingSyncPending(row.id)),
                  { concurrency: 1, discard: true },
                ),
          ),
        ),

      'Guild/GetOnboardingRulesRoleId': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.teams.getOnboardingRulesRoleIdByGuildId(guild_id),

      'Guild/SyncCommunityFlags': ({
        guilds,
      }: {
        readonly guilds: ReadonlyArray<{
          readonly guild_id: Discord.Snowflake;
          readonly is_community_enabled: boolean;
        }>;
      }) =>
        deps.botGuilds
          .bulkUpdateCommunityFlags(
            Array.map(guilds, (g) => ({
              guildId: g.guild_id,
              isCommunityEnabled: g.is_community_enabled,
            })),
          )
          .pipe(
            Effect.flatMap(() =>
              Effect.all(
                pipe(
                  guilds,
                  Array.filter((g) => g.is_community_enabled),
                  Array.map((g) => deps.teams.flipPendingOnboardingSyncForGuild(g.guild_id)),
                ),
                { concurrency: 'unbounded' },
              ),
            ),
            Effect.asVoid,
          ),

      'Guild/ListGuildRoles': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.discordRoles.listByGuild(guild_id),

      'Guild/SyncGuildRoles': ({
        guild_id,
        roles,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly roles: ReadonlyArray<{
          readonly role_id: Discord.Snowflake;
          readonly name: string;
          readonly color: number;
          readonly position: number;
          readonly managed: boolean;
        }>;
      }) => deps.discordRoles.syncForGuild(guild_id, roles),

      'Guild/UpsertGuildRole': ({
        guild_id,
        role_id,
        name,
        color,
        position,
        managed,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly role_id: Discord.Snowflake;
        readonly name: string;
        readonly color: number;
        readonly position: number;
        readonly managed: boolean;
      }) => deps.discordRoles.upsert({ guild_id, role_id, name, color, position, managed }),

      'Guild/DeleteGuildRole': ({
        guild_id,
        role_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly role_id: Discord.Snowflake;
      }) => deps.discordRoles.delete(guild_id, role_id),
    };
  }),
  (handlers) => GuildRpcGroup.GuildRpcGroup.toLayer(handlers),
);
