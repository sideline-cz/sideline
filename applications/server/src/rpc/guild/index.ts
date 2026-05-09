import { type Discord, GuildRpcGroup, type Team, type TeamMember } from '@sideline/domain';
import { applyTemplate, sanitizeHexColor, sanitizeRendered } from '@sideline/template-renderer';
import { Array, Effect, Option, pipe } from 'effect';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
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
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('roleMappings', () => DiscordRoleMappingRepository.asEffect()),
  Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
  Effect.bind('groups', () => GroupsRepository.asEffect()),
  Effect.bind('invites', () => TeamInvitesRepository.asEffect()),
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
      return Option.match(payload.invite_code, {
        onNone: () => Effect.succeed(noWelcome),
        onSome: (code) =>
          deps.invites.findByCodeWithContext(code).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.logWarning(
                    `RegisterMember: invite code ${code} not found or expired`,
                  ).pipe(Effect.as(noWelcome)),
                onSome: (ctx) => {
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
                },
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
                  deps.members.findMembershipByIds(team.id, user.id),
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
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly guild_name: string;
      }) => deps.botGuilds.upsert(guild_id, guild_name),

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
    };
  }),
  (handlers) => GuildRpcGroup.GuildRpcGroup.toLayer(handlers),
);
