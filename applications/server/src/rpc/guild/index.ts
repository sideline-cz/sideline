import {
  type Discord,
  EventRpcModels,
  type GroupModel,
  GuildRpcGroup,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { LogicError, Schemas } from '@sideline/effect-lib';
import { applyTemplate, sanitizeHexColor, sanitizeRendered } from '@sideline/template-renderer';
import { Array, Effect, Option, pipe, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
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
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT } from '~/utils/applyDiscordFormat.js';

type IdentifyEventsChannelResult = {
  readonly kind: 'global' | 'personal' | 'none';
  readonly team_id: Option.Option<Team.TeamId>;
  readonly team_member_id: Option.Option<string>;
  readonly owner_discord_id: Option.Option<Discord.Snowflake>;
  readonly is_admin: boolean;
};
/** Widens the `kind` literal so all branches share one return type. */
const identifyResult = (r: IdentifyEventsChannelResult): IdentifyEventsChannelResult => r;

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
  Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
  Effect.bind('personalChannels', () => PersonalEventChannelsRepository.asEffect()),
  Effect.bind('overflowCategories', () => PersonalEventOverflowCategoriesRepository.asEffect()),
  Effect.bind('events', () => EventsRepository.asEffect()),
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
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

      'Guild/GetGuildsNeedingPersonalProvisioning': ({ limit }: { readonly limit: number }) =>
        deps.personalChannels.getGuildsNeedingPersonalProvisioning(limit),

      'Guild/GetPersonalEventsCategory': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<Discord.Snowflake>()),
              onSome: (team) =>
                deps.teamSettings
                  .findByTeamId(team.id)
                  .pipe(Effect.map(Option.flatMap((s) => s.discord_personal_events_category_id))),
            }),
          ),
        ),

      'Guild/GetMembersNeedingPersonalChannel': ({
        guild_id,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly limit: number;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  [] as ReadonlyArray<{
                    readonly team_id: Team.TeamId;
                    readonly team_member_id: string;
                    readonly discord_id: Discord.Snowflake;
                    readonly name: string;
                    readonly channel_format: string;
                  }>,
                ),
              onSome: (team) =>
                deps.teamSettings.findByTeamId(team.id).pipe(
                  Effect.flatMap((settingsOpt) => {
                    const groupId = Option.flatMap(
                      settingsOpt,
                      (s) => s.discord_personal_events_group_id,
                    );
                    const channelFormat = Option.match(settingsOpt, {
                      onNone: () => DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
                      onSome: (s) => s.discord_personal_events_channel_format,
                    });
                    return deps.personalChannels
                      .getMembersNeedingPersonalChannel(team.id, groupId, limit)
                      .pipe(
                        Effect.map(
                          Array.map((m) => ({
                            team_id: team.id,
                            team_member_id: m.team_member_id,
                            discord_id: m.discord_id,
                            name: m.name,
                            channel_format: channelFormat,
                          })),
                        ),
                      );
                  }),
                ),
            }),
          ),
        ),

      'Guild/GetPersonalChannelsToDeprovision': ({
        guild_id,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly limit: number;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  [] as ReadonlyArray<{
                    readonly team_id: Team.TeamId;
                    readonly team_member_id: string;
                    readonly discord_channel_id: Discord.Snowflake;
                  }>,
                ),
              onSome: (team) =>
                deps.teamSettings.findByTeamId(team.id).pipe(
                  Effect.flatMap((settingsOpt) =>
                    Option.match(
                      Option.flatMap(settingsOpt, (s) => s.discord_personal_events_group_id),
                      {
                        // No group restriction → nothing to de-provision.
                        onNone: () =>
                          Effect.succeed(
                            [] as ReadonlyArray<{
                              readonly team_id: Team.TeamId;
                              readonly team_member_id: string;
                              readonly discord_channel_id: Discord.Snowflake;
                            }>,
                          ),
                        onSome: (groupId) =>
                          deps.personalChannels
                            .getMembersToDeprovision(team.id, groupId, limit)
                            .pipe(
                              Effect.map(
                                Array.map((m) => ({
                                  team_id: team.id,
                                  team_member_id: m.team_member_id,
                                  discord_channel_id: m.discord_channel_id,
                                })),
                              ),
                            ),
                      },
                    ),
                  ),
                ),
            }),
          ),
        ),

      'Guild/ReservePersonalChannel': ({
        team_id,
        team_member_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: string;
      }) =>
        deps.personalChannels
          .reservePersonalChannel(team_id, team_member_id as TeamMember.TeamMemberId)
          .pipe(Effect.map((reserved) => ({ reserved }))),

      'Guild/SavePersonalChannelId': ({
        team_id,
        team_member_id,
        discord_channel_id,
        channel_format,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: string;
        readonly discord_channel_id: Discord.Snowflake;
        readonly channel_format: string;
      }) =>
        deps.personalChannels.savePersonalChannelId(
          team_id,
          team_member_id as TeamMember.TeamMemberId,
          discord_channel_id,
          channel_format,
        ),

      'Guild/SavePersonalChannelFormat': ({
        team_id,
        team_member_id,
        channel_format,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: string;
        readonly channel_format: string;
      }) =>
        deps.personalChannels.savePersonalChannelFormat(
          team_id,
          team_member_id as TeamMember.TeamMemberId,
          channel_format,
        ),

      'Guild/MarkTeamPersonalEventsDirty': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.events.markTeamUpcomingEventsPersonalMessagesDirty(team_id),

      'Guild/IdentifyEventsChannel': ({
        guild_id,
        channel_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channel_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  identifyResult({
                    kind: 'none',
                    team_id: Option.none(),
                    team_member_id: Option.none(),
                    owner_discord_id: Option.none(),
                    is_admin: false,
                  }),
                ),
              onSome: (team) =>
                // Resolve the caller's team membership to gate on the `team:manage`
                // permission (Sideline's admin gate — Discord perms aren't used here).
                deps.members.findMembershipByDiscordAndTeam(discord_user_id, team.id).pipe(
                  Effect.map(
                    Option.match({
                      onNone: () => false,
                      onSome: (membership) => membership.permissions.includes('team:manage'),
                    }),
                  ),
                  Effect.flatMap((isAdmin) =>
                    deps.teamSettings.findByTeamId(team.id).pipe(
                      Effect.flatMap((settingsOpt) => {
                        const globalChannel = Option.flatMap(
                          settingsOpt,
                          (s) => s.discord_events_channel_id,
                        );
                        if (Option.isSome(globalChannel) && globalChannel.value === channel_id) {
                          return Effect.succeed(
                            identifyResult({
                              kind: 'global',
                              team_id: Option.some(team.id),
                              team_member_id: Option.none(),
                              owner_discord_id: Option.none(),
                              is_admin: isAdmin,
                            }),
                          );
                        }
                        return deps.personalChannels
                          .findPersonalChannelOwner(team.id, channel_id)
                          .pipe(
                            Effect.map(
                              Option.match({
                                onNone: () =>
                                  identifyResult({
                                    kind: 'none',
                                    team_id: Option.some(team.id),
                                    team_member_id: Option.none(),
                                    owner_discord_id: Option.none(),
                                    is_admin: isAdmin,
                                  }),
                                onSome: (owner) =>
                                  identifyResult({
                                    kind: 'personal',
                                    team_id: Option.some(team.id),
                                    team_member_id: Option.some(String(owner.team_member_id)),
                                    owner_discord_id: Option.some(owner.discord_id),
                                    is_admin: isAdmin,
                                  }),
                              }),
                            ),
                          );
                      }),
                    ),
                  ),
                ),
            }),
          ),
        ),

      'Guild/CheckTeamAdmin': ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed({ team_id: Option.none<Team.TeamId>(), is_admin: false }),
              onSome: (team) =>
                deps.members.findMembershipByDiscordAndTeam(discord_user_id, team.id).pipe(
                  Effect.map(
                    Option.match({
                      onNone: () => ({ team_id: Option.some(team.id), is_admin: false }),
                      onSome: (membership) => ({
                        team_id: Option.some(team.id),
                        is_admin: membership.permissions.includes('team:manage'),
                      }),
                    }),
                  ),
                ),
            }),
          ),
        ),

      'Guild/GetPersonalChannelsToRename': ({
        guild_id,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly limit: number;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  [] as ReadonlyArray<{
                    readonly team_id: Team.TeamId;
                    readonly team_member_id: string;
                    readonly discord_id: Discord.Snowflake;
                    readonly discord_channel_id: Discord.Snowflake;
                    readonly name: string;
                    readonly channel_format: string;
                  }>,
                ),
              onSome: (team) =>
                deps.personalChannels.getChannelsToRename(team.id, limit).pipe(
                  Effect.map(
                    Array.map((m) => ({
                      team_id: team.id,
                      team_member_id: m.team_member_id,
                      discord_id: m.discord_id,
                      discord_channel_id: m.discord_channel_id,
                      name: m.name,
                      channel_format: m.channel_format,
                    })),
                  ),
                ),
            }),
          ),
        ),

      'Guild/GetPersonalChannel': ({
        team_id,
        team_member_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: string;
      }) =>
        deps.personalChannels
          .getPersonalChannel(team_id, team_member_id as TeamMember.TeamMemberId)
          .pipe(Effect.map(Option.flatMap((row) => row.discord_channel_id))),

      'Guild/DeletePersonalChannel': ({
        team_id,
        team_member_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: string;
      }) =>
        deps.personalChannels.deletePersonalChannel(
          team_id,
          team_member_id as TeamMember.TeamMemberId,
        ),

      'Guild/ListPersonalChannelsForEvent': ({ event_id }: { readonly event_id: string }) =>
        deps.personalChannels.listPersonalChannelsForEvent(event_id),

      'Guild/GetPersonalChannelTargetCategory': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.teamSettings.findByTeamId(team_id).pipe(
          Effect.flatMap((settingsOpt) => {
            const baseCategory = Option.flatMap(
              settingsOpt,
              (s) => s.discord_personal_events_category_id,
            );
            if (Option.isNone(baseCategory)) {
              return Effect.succeed({
                category_id: Option.none<Discord.Snowflake>(),
                is_overflow: false,
              });
            }
            return deps.overflowCategories.listPersonalOverflowCategories(team_id).pipe(
              Effect.map((overflows) => {
                if (overflows.length === 0) {
                  return { category_id: baseCategory, is_overflow: false };
                }
                const resolvedOverflow = Array.findLast(overflows, (o) =>
                  Option.isSome(o.discord_category_id),
                );
                if (Option.isNone(resolvedOverflow)) {
                  return { category_id: baseCategory, is_overflow: false };
                }
                return {
                  category_id: resolvedOverflow.value.discord_category_id,
                  is_overflow: true,
                };
              }),
            );
          }),
        ),

      'Guild/AllocatePersonalOverflowCategory': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.overflowCategories.listPersonalOverflowCategories(team_id).pipe(
          Effect.flatMap((existing) => {
            const nextSequence = existing.length + 1;
            return deps.overflowCategories
              .allocatePersonalOverflowCategory(team_id, nextSequence)
              .pipe(
                Effect.map((idOpt) => ({
                  sequence: nextSequence,
                  exists: Option.isSome(idOpt),
                })),
              );
          }),
        ),

      'Guild/SavePersonalOverflowCategoryId': ({
        team_id,
        sequence,
        discord_category_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly sequence: number;
        readonly discord_category_id: Discord.Snowflake;
      }) =>
        deps.overflowCategories.savePersonalOverflowCategoryId(
          team_id,
          sequence,
          discord_category_id,
        ),

      'Guild/ListPersonalOverflowCategories': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.overflowCategories
          .listPersonalOverflowCategories(team_id)
          .pipe(
            Effect.map((rows) =>
              rows.flatMap((row) =>
                Option.isSome(row.discord_category_id)
                  ? [{ sequence: row.sequence, discord_category_id: row.discord_category_id.value }]
                  : [],
              ),
            ),
          ),

      'Guild/GetAllUpcomingEventsForUser': ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            deps.teams.findByGuildId(guild_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new EventRpcModels.GuildNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.bind('member', ({ team }) =>
            SqlSchema.findOne({
              Request: Schema.Struct({ discord_user_id: Schema.String, team_id: Schema.String }),
              Result: Schema.Struct({ id: Schema.String }),
              execute: (input) =>
                deps.sql`
                  SELECT tm.id FROM team_members tm
                  JOIN users u ON u.id = tm.user_id
                  WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
                    AND tm.active = true
                `,
            })({ discord_user_id, team_id: team.id }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.RsvpMemberNotFound()),
              ),
              Effect.mapError(() => new EventRpcModels.RsvpMemberNotFound()),
            ),
          ),
          Effect.bind('rows', ({ team, member }) =>
            SqlSchema.findAll({
              Request: Schema.Struct({
                team_id: Schema.String,
                team_member_id: Schema.String,
              }),
              Result: Schema.Struct({
                event_id: Schema.String,
                team_id: Schema.String,
                title: Schema.String,
                description: Schema.OptionFromNullOr(Schema.String),
                image_url: Schema.OptionFromNullOr(Schema.String),
                start_at: Schemas.DateTimeFromDate,
                end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
                location: Schema.OptionFromNullOr(Schema.String),
                location_url: Schema.OptionFromNullOr(Schema.String),
                event_type: Schema.String,
                yes_count: Schema.Number,
                no_count: Schema.Number,
                maybe_count: Schema.Number,
                my_response: Schema.OptionFromNullOr(Schema.Literals(['yes', 'no', 'maybe'])),
                my_message: Schema.OptionFromNullOr(Schema.String),
                all_day: Schema.Boolean,
              }),
              execute: (input) =>
                deps.sql`
                  SELECT
                    e.id AS event_id,
                    e.team_id,
                    e.title,
                    e.description,
                    e.image_url,
                    e.start_at,
                    e.end_at,
                    e.location,
                    e.location_url,
                    e.event_type,
                    e.all_day,
                    COALESCE(SUM(CASE WHEN er.response = 'yes' THEN 1 ELSE 0 END), 0)::int AS yes_count,
                    COALESCE(SUM(CASE WHEN er.response = 'no' THEN 1 ELSE 0 END), 0)::int AS no_count,
                    COALESCE(SUM(CASE WHEN er.response = 'maybe' THEN 1 ELSE 0 END), 0)::int AS maybe_count,
                    my_rsvp.response AS my_response,
                    my_rsvp.message AS my_message
                  FROM events e
                  LEFT JOIN event_rsvps er ON er.event_id = e.id
                  LEFT JOIN event_rsvps my_rsvp ON my_rsvp.event_id = e.id
                    AND my_rsvp.team_member_id = ${input.team_member_id}
                  WHERE e.team_id = ${input.team_id}
                    AND e.status = 'active'
                    AND e.start_at >= now()
                    AND (
                      e.member_group_id IS NULL
                      OR EXISTS (
                        WITH RECURSIVE descendant_groups AS (
                          SELECT id FROM groups WHERE id = e.member_group_id AND team_id = ${input.team_id}
                          UNION ALL
                          SELECT g.id FROM groups g JOIN descendant_groups dg ON g.parent_id = dg.id WHERE g.team_id = ${input.team_id}
                        )
                        SELECT 1 FROM group_members gm
                        WHERE gm.group_id IN (SELECT id FROM descendant_groups)
                          AND gm.team_member_id = ${input.team_member_id}
                      )
                    )
                  GROUP BY e.id, my_rsvp.response, my_rsvp.message
                  ORDER BY e.start_at ASC
                `,
            })({ team_id: team.id, team_member_id: member.id }).pipe(
              Effect.catchTag(
                ['SqlError', 'SchemaError'],
                LogicError.withMessage(
                  (e) => `Failed querying all upcoming events for user: ${e.message}`,
                ),
              ),
            ),
          ),
          Effect.map(
            ({ rows, team }) =>
              new EventRpcModels.UpcomingEventsForUserResult({
                events: Array.map(
                  rows,
                  (row) =>
                    new EventRpcModels.UpcomingEventForUserEntry({
                      event_id: row.event_id,
                      team_id: row.team_id,
                      title: row.title,
                      description: row.description,
                      image_url: row.image_url,
                      start_at: row.start_at,
                      end_at: row.end_at,
                      location: row.location,
                      location_url: row.location_url,
                      event_type: row.event_type,
                      yes_count: row.yes_count,
                      no_count: row.no_count,
                      maybe_count: row.maybe_count,
                      my_response: row.my_response,
                      my_message: row.my_message,
                      all_day: row.all_day,
                    }),
                ),
                total: rows.length,
                team_id: team.id,
              }),
          ),
        ),
    };
  }),
  (handlers) => GuildRpcGroup.GuildRpcGroup.toLayer(handlers),
);
