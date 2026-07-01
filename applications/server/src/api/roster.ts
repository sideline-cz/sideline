import {
  Auth,
  type Discord,
  DisplayName,
  type GroupModel,
  Roster,
  type RosterModel,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { LogicError, Options } from '@sideline/effect-lib';
import { Array, DateTime, Effect, Match, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import {
  hasPermission,
  requireMembership,
  requirePermission,
  requireReadAccess,
} from '~/api/permissions.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import type { RosterEntry } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import {
  applyDiscordFormat,
  DEFAULT_CHANNEL_FORMAT,
  DEFAULT_ROLE_FORMAT,
} from '~/utils/applyDiscordFormat.js';
import { backfillRosterRoleMembers } from '~/utils/backfillRosterRoleMembers.js';
import { hexColorToDiscordInt } from '~/utils/hexColorToDiscordInt.js';
import { reconcileRosterRoleExtras } from '~/utils/reconcileRosterRoleExtras.js';

const toRosterPlayer = (entry: RosterEntry) =>
  new Roster.RosterPlayer({
    memberId: entry.member_id,
    userId: entry.user_id,
    discordId: entry.discord_id,
    roleNames: entry.role_names,
    permissions: entry.permissions,
    name: entry.name,
    birthDate: entry.birth_date,
    gender: entry.gender,
    jerseyNumber: entry.jersey_number,
    username: entry.username,
    avatar: entry.avatar,
    displayName: Option.getOrElse(
      DisplayName.pickDisplayName({
        name: entry.name,
        nickname: entry.discord_nickname,
        displayName: entry.discord_display_name,
        username: Option.some(entry.username),
      }),
      () => entry.username,
    ),
    joinedAt: entry.joined_at,
    active: entry.active,
  });

type ChannelLike = { readonly channel_id: Discord.Snowflake; readonly name: string };

type SettingsRow = {
  readonly discord_channel_format: string;
  readonly discord_role_format: string;
};

const deriveChannelNames = (
  settings: Option.Option<SettingsRow>,
  name: string,
  emoji: Option.Option<string>,
  color: Option.Option<string>,
) => ({
  channelName: applyDiscordFormat(
    Option.match(settings, {
      onNone: () => DEFAULT_CHANNEL_FORMAT,
      onSome: (s) => s.discord_channel_format,
    }),
    name,
    emoji,
  ),
  roleName: applyDiscordFormat(
    Option.match(settings, {
      onNone: () => DEFAULT_ROLE_FORMAT,
      onSome: (s) => s.discord_role_format,
    }),
    name,
    emoji,
  ),
  discordRoleColor: Option.map(color, hexColorToDiscordInt),
});

const resolveChannelName = (
  channelId: Option.Option<Discord.Snowflake>,
  allChannels: readonly ChannelLike[],
): Option.Option<string> =>
  Option.flatMap(channelId, (id) =>
    Option.fromNullishOr(allChannels.find((ch) => ch.channel_id === id)?.name),
  );

const toRosterInfo = (
  r: RosterModel.Roster,
  memberCount: number,
  allChannels: readonly ChannelLike[],
  discordChannelProvisioning: boolean,
): Roster.RosterInfo =>
  new Roster.RosterInfo({
    rosterId: r.id,
    teamId: r.team_id,
    name: r.name,
    active: r.active,
    memberCount,
    createdAt: DateTime.formatIso(r.created_at),
    color: r.color,
    emoji: r.emoji,
    discordChannelId: r.discord_channel_id,
    discordChannelName: resolveChannelName(r.discord_channel_id, allChannels),
    discordChannelProvisioning,
  });

// Reconciles the member's Discord roster/group role & channel access with their active state.
// Called on deactivate ('member_removed' — revoke access) and reactivate ('member_added' —
// restore access). Mirrors the emit pattern used by addRosterMember/removeRosterMember and
// addGroupMember/removeGroupMember, including ancestor groups for the group side.
const emitDiscordCleanupForMember = (
  deps: {
    rosters: {
      findRosterIdsByMember: (
        memberId: TeamMember.TeamMemberId,
      ) => Effect.Effect<readonly RosterModel.RosterId[], never>;
      findRosterById: (
        rosterId: RosterModel.RosterId,
      ) => Effect.Effect<Option.Option<RosterModel.Roster>, never>;
    };
    groups: {
      findGroupIdsByMember: (
        memberId: TeamMember.TeamMemberId,
      ) => Effect.Effect<readonly GroupModel.GroupId[], never>;
      findGroupById: (
        groupId: GroupModel.GroupId,
      ) => Effect.Effect<Option.Option<{ readonly name: string }>, never>;
      getAncestors: (
        groupId: GroupModel.GroupId,
      ) => Effect.Effect<
        readonly { readonly id: GroupModel.GroupId; readonly name: string }[],
        never
      >;
    };
    channelSync: {
      emitRosterMemberAdded: (
        teamId: Team.TeamId,
        rosterId: RosterModel.RosterId,
        rosterName: string,
        memberId: TeamMember.TeamMemberId,
        discordUserId: Option.Option<Discord.Snowflake>,
      ) => Effect.Effect<void, never>;
      emitRosterMemberRemoved: (
        teamId: Team.TeamId,
        rosterId: RosterModel.RosterId,
        rosterName: string,
        memberId: TeamMember.TeamMemberId,
        discordUserId: Option.Option<Discord.Snowflake>,
      ) => Effect.Effect<void, never>;
      emitMemberAdded: (
        teamId: Team.TeamId,
        groupId: GroupModel.GroupId,
        groupName: string,
        memberId: TeamMember.TeamMemberId,
        discordUserId: Discord.Snowflake,
      ) => Effect.Effect<void, never>;
      emitMemberRemoved: (
        teamId: Team.TeamId,
        groupId: GroupModel.GroupId,
        groupName: string,
        memberId: TeamMember.TeamMemberId,
        discordUserId: Discord.Snowflake,
      ) => Effect.Effect<void, never>;
    };
  },
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  discordUserId: Discord.Snowflake,
  eventKind: 'member_added' | 'member_removed',
) => {
  const { rosters, groups, channelSync } = deps;
  const emitRoster =
    eventKind === 'member_added'
      ? channelSync.emitRosterMemberAdded
      : channelSync.emitRosterMemberRemoved;
  const emitGroup =
    eventKind === 'member_added' ? channelSync.emitMemberAdded : channelSync.emitMemberRemoved;

  return Effect.Do.pipe(
    Effect.bind('rosterIds', () => rosters.findRosterIdsByMember(memberId)),
    Effect.bind('groupIds', () => groups.findGroupIdsByMember(memberId)),
    Effect.tap(({ rosterIds }) =>
      Effect.forEach(
        rosterIds,
        (rosterId) =>
          rosters.findRosterById(rosterId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (roster) =>
                  emitRoster(teamId, rosterId, roster.name, memberId, Option.some(discordUserId)),
              }),
            ),
          ),
        { concurrency: 'unbounded' },
      ),
    ),
    Effect.tap(({ groupIds }) =>
      Effect.forEach(
        groupIds,
        (groupId) =>
          groups.findGroupById(groupId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (group) =>
                  Effect.all(
                    [
                      emitGroup(teamId, groupId, group.name, memberId, discordUserId),
                      groups
                        .getAncestors(groupId)
                        .pipe(
                          Effect.flatMap((ancestors) =>
                            Effect.forEach(ancestors, (ancestor) =>
                              emitGroup(
                                teamId,
                                ancestor.id,
                                ancestor.name,
                                memberId,
                                discordUserId,
                              ),
                            ),
                          ),
                        ),
                    ],
                    { concurrency: 'unbounded' },
                  ),
              }),
            ),
          ),
        { concurrency: 'unbounded' },
      ),
    ),
    Effect.asVoid,
  );
};

export const RosterApiLive = HttpApiBuilder.group(Api, 'roster', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('users', () => UsersRepository.asEffect()),
    Effect.bind('rosters', () => RostersRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('discordChannels', () => DiscordChannelsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
    Effect.map(
      ({
        members,
        users,
        rosters,
        groups,
        teams,
        discordChannels,
        channelSync,
        teamSettings,
        channelMappings,
      }) =>
        handlers
          .handle('listMembers', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('membership', () =>
                requireReadAccess(members, teamId, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:view', new Roster.Forbidden()),
              ),
              Effect.bind('roster', () => members.findRosterByTeam(teamId)),
              Effect.map(({ roster }) => Array.map(roster, toRosterPlayer)),
            ),
          )
          .handle('getMember', ({ params: { teamId, memberId } }) =>
            Effect.Do.pipe(
              Effect.bind('membership', () =>
                requireReadAccess(members, teamId, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:view', new Roster.Forbidden()),
              ),
              Effect.bind('entry', () =>
                members.findRosterMemberByIds(teamId, memberId, { includeInactive: true }).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.map(({ entry }) => toRosterPlayer(entry)),
            ),
          )
          .handle('updateMember', ({ params: { teamId, memberId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:edit', new Roster.Forbidden()),
              ),
              Effect.bind('entry', () =>
                members.findRosterMemberByIds(teamId, memberId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('updated', ({ entry }) =>
                users.updateAdminProfile({
                  id: entry.user_id,
                  name: payload.name,
                  birth_date: Option.map(payload.birthDate, DateTime.makeUnsafe),
                  gender: payload.gender,
                }),
              ),
              Effect.tap(({ entry }) =>
                members.setJerseyNumber(entry.member_id, payload.jerseyNumber),
              ),
              Effect.map(
                ({ entry, updated }) =>
                  new Roster.RosterPlayer({
                    memberId: entry.member_id,
                    userId: entry.user_id,
                    discordId: entry.discord_id,
                    roleNames: entry.role_names,
                    permissions: entry.permissions,
                    name: updated.name,
                    birthDate: Option.map(updated.birth_date, DateTime.formatIsoDateUtc),
                    gender: updated.gender,
                    jerseyNumber: payload.jerseyNumber,
                    username: entry.username,
                    avatar: entry.avatar,
                    displayName: Option.getOrElse(
                      DisplayName.pickDisplayName({
                        name: updated.name,
                        nickname: entry.discord_nickname,
                        displayName: entry.discord_display_name,
                        username: Option.some(entry.username),
                      }),
                      () => entry.username,
                    ),
                    joinedAt: entry.joined_at,
                    active: entry.active,
                  }),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(
                  () => 'Failed updating roster member profile — no row returned',
                ),
              ),
            ),
          )
          .handle('deactivateMember', ({ params: { teamId, memberId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:remove', new Roster.Forbidden()),
              ),
              Effect.bind('member', () =>
                members.findRosterMemberByIds(teamId, memberId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ currentUser, member }) =>
                member.user_id === currentUser.id
                  ? Effect.fail(new Roster.Forbidden())
                  : Effect.void,
              ),
              Effect.tap(() => members.deactivateMemberByIds(teamId, memberId)),
              Effect.tap(({ member }) =>
                emitDiscordCleanupForMember(
                  { rosters, groups, channelSync },
                  teamId,
                  memberId,
                  member.discord_id,
                  'member_removed',
                ),
              ),
              Effect.asVoid,
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed deactivating roster member — no row returned'),
              ),
            ),
          )
          .handle('reactivateMember', ({ params: { teamId, memberId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:remove', new Roster.Forbidden()),
              ),
              // The target member is inactive — `findRosterMemberByIds` (active-filtered) would
              // self-404 here, so look the member up with `includeInactive: true` instead, and
              // confirm team ownership ourselves since `reactivateMemberQuery` is team-blind
              // (`WHERE id = $member_id`, no team scope).
              Effect.bind('member', () =>
                members.findRosterMemberByIds(teamId, memberId, { includeInactive: true }).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() => members.reactivateMember(memberId)),
              Effect.tap(({ member }) =>
                emitDiscordCleanupForMember(
                  { rosters, groups, channelSync },
                  teamId,
                  memberId,
                  member.discord_id,
                  'member_added',
                ),
              ),
              Effect.asVoid,
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed reactivating roster member — no row returned'),
              ),
            ),
          )
          .handle('listMemberRosters', ({ params: { teamId, memberId } }) =>
            Effect.Do.pipe(
              Effect.bind('membership', () =>
                requireReadAccess(members, teamId, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:view', new Roster.Forbidden()),
              ),
              Effect.bind('_check', () =>
                members.findRosterMemberByIds(teamId, memberId, { includeInactive: true }).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('memberRosterIds', () => rosters.findRosterIdsByMember(memberId)),
              Effect.bind('rosterList', ({ memberRosterIds }) =>
                rosters.findByTeamId(teamId).pipe(
                  Effect.map((all) => {
                    const memberRosterIdSet = new Set(memberRosterIds);
                    return all.filter((r) => memberRosterIdSet.has(r.id));
                  }),
                ),
              ),
              Effect.bind('team', () =>
                teams
                  .findById(teamId)
                  .pipe(Effect.flatMap(Options.toEffect(() => new Roster.Forbidden()))),
              ),
              Effect.bind('allChannels', ({ team }) =>
                discordChannels.findByGuildId(team.guild_id),
              ),
              Effect.bind('provisioningIds', ({ rosterList }) =>
                channelSync.hasUnprocessedForRosters(rosterList.map((r) => r.id)),
              ),
              Effect.map(({ rosterList, allChannels, provisioningIds }) => {
                const provisioningSet = new Set(provisioningIds);
                return Array.map(rosterList, (r) =>
                  toRosterInfo(r, r.member_count, allChannels, provisioningSet.has(r.id)),
                );
              }),
            ),
          )
          .handle('listRosters', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('membership', () =>
                requireReadAccess(members, teamId, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:view', new Roster.Forbidden()),
              ),
              Effect.let('canManage', ({ membership }) =>
                hasPermission(membership, 'roster:manage'),
              ),
              Effect.bind('rosterList', () => rosters.findByTeamId(teamId)),
              Effect.bind('team', () =>
                teams
                  .findById(teamId)
                  .pipe(Effect.flatMap(Options.toEffect(() => new Roster.Forbidden()))),
              ),
              Effect.bind('allChannels', ({ team }) =>
                discordChannels.findByGuildId(team.guild_id),
              ),
              Effect.bind('provisioningIds', ({ rosterList }) =>
                channelSync.hasUnprocessedForRosters(rosterList.map((r) => r.id)),
              ),
              Effect.map(({ rosterList, canManage, allChannels, provisioningIds }) => {
                const provisioningSet = new Set(provisioningIds);
                return new Roster.RosterListResponse({
                  canManage,
                  rosters: Array.map(
                    rosterList,
                    (r) =>
                      new Roster.RosterInfo({
                        rosterId: r.id,
                        teamId: r.team_id,
                        name: r.name,
                        active: r.active,
                        memberCount: r.member_count,
                        createdAt: DateTime.formatIso(r.created_at),
                        color: r.color,
                        emoji: r.emoji,
                        discordChannelId: r.discord_channel_id,
                        discordChannelName: resolveChannelName(r.discord_channel_id, allChannels),
                        discordChannelProvisioning: provisioningSet.has(r.id),
                      }),
                  ),
                });
              }),
            ),
          )
          .handle('createRoster', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('roster', () =>
                rosters.insert({
                  team_id: teamId,
                  name: payload.name,
                  active: true,
                  color: payload.color,
                  emoji: payload.emoji,
                }),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ roster, settings }) => {
                const { channelName, roleName, discordRoleColor } = deriveChannelNames(
                  settings,
                  roster.name,
                  roster.emoji,
                  roster.color,
                );
                return Option.match(settings, {
                  onNone: () =>
                    channelSync.emitRosterChannelCreated(
                      teamId,
                      roster.id,
                      roster.name,
                      Option.none(),
                      channelName,
                      roleName,
                      discordRoleColor,
                    ),
                  onSome: (s) =>
                    s.create_discord_channel_on_roster
                      ? channelSync.emitRosterChannelCreated(
                          teamId,
                          roster.id,
                          roster.name,
                          Option.none(),
                          channelName,
                          roleName,
                          discordRoleColor,
                          s.discord_roster_category_id,
                        )
                      : Effect.void,
                });
              }),
              Effect.map(({ roster }) => toRosterInfo(roster, 0, [], false)),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed creating roster — no row returned'),
              ),
            ),
          )
          .handle('getRoster', ({ params: { teamId, rosterId } }) =>
            Effect.Do.pipe(
              Effect.bind('membership', () =>
                requireReadAccess(members, teamId, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:view', new Roster.Forbidden()),
              ),
              Effect.let('canManage', ({ membership }) =>
                hasPermission(membership, 'roster:manage'),
              ),
              Effect.bind('roster', () =>
                rosters.findRosterById(rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.RosterNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('rosterMembers', ({ roster }) =>
                rosters.findMemberEntriesById(roster.id),
              ),
              Effect.bind('team', () =>
                teams
                  .findById(teamId)
                  .pipe(Effect.flatMap(Options.toEffect(() => new Roster.Forbidden()))),
              ),
              Effect.bind('allChannels', ({ team }) =>
                discordChannels.findByGuildId(team.guild_id),
              ),
              Effect.bind('provisioningIds', () =>
                channelSync.hasUnprocessedForRosters([rosterId]),
              ),
              Effect.map(
                ({ roster, rosterMembers, canManage, allChannels, provisioningIds }) =>
                  new Roster.RosterDetail({
                    rosterId: roster.id,
                    teamId: roster.team_id,
                    name: roster.name,
                    active: roster.active,
                    createdAt: DateTime.formatIso(roster.created_at),
                    color: roster.color,
                    emoji: roster.emoji,
                    members: Array.map(rosterMembers, toRosterPlayer),
                    canManage,
                    discordChannelId: roster.discord_channel_id,
                    discordChannelName: resolveChannelName(roster.discord_channel_id, allChannels),
                    discordChannelProvisioning: provisioningIds.length > 0,
                  }),
              ),
            ),
          )
          .handle('updateRoster', ({ params: { teamId, rosterId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('existing', () =>
                rosters.findRosterById(rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.RosterNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() =>
                Option.match(payload.discordChannelId, {
                  onNone: () => Effect.void,
                  onSome: (inner) =>
                    Option.match(inner, {
                      onNone: () => Effect.void,
                      onSome: (channelId) =>
                        channelMappings
                          .findAllByTeam(teamId)
                          .pipe(
                            Effect.flatMap((mappings) =>
                              mappings.some(
                                (m) =>
                                  Option.isSome(m.discord_channel_id) &&
                                  m.discord_channel_id.value === channelId,
                              )
                                ? Effect.fail(new Roster.ChannelAlreadyLinked())
                                : Effect.void,
                            ),
                          ),
                    }),
                }),
              ),
              Effect.bind('updated', () =>
                rosters.update({
                  id: rosterId,
                  name: payload.name,
                  active: payload.active,
                  color: payload.color,
                  emoji: payload.emoji,
                  discord_channel_id: payload.discordChannelId,
                }),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ existing, updated, settings }) => {
                const isReactivated = existing.active === false && updated.active === true;
                const isDeactivated = existing.active === true && updated.active === false;

                if (isReactivated) {
                  // If the PATCH also links an existing channel, link THAT channel (don't auto-create a fresh one).
                  const linkedChannel = Option.flatten(payload.discordChannelId);
                  if (Option.isSome(linkedChannel)) {
                    const { channelName, roleName, discordRoleColor } = deriveChannelNames(
                      settings,
                      updated.name,
                      updated.emoji,
                      updated.color,
                    );
                    return channelSync.emitRosterChannelCreated(
                      teamId,
                      updated.id,
                      updated.name,
                      linkedChannel,
                      channelName,
                      roleName,
                      discordRoleColor,
                      Option.none(),
                    );
                  }
                  // Explicit unlink (Some(None)) during reactivation: nothing to provision.
                  if (Option.isSome(payload.discordChannelId)) return Effect.void;
                  // No channel specified: auto-create a fresh channel in the configured category.
                  const shouldCreate = Option.match(settings, {
                    onNone: () => false,
                    onSome: (s) => s.create_discord_channel_on_roster,
                  });
                  if (!shouldCreate) return Effect.void;
                  if (Option.isSome(existing.discord_channel_id)) return Effect.void;

                  const { channelName, roleName, discordRoleColor } = deriveChannelNames(
                    settings,
                    updated.name,
                    updated.emoji,
                    updated.color,
                  );
                  const targetCategoryId = Option.flatMap(
                    settings,
                    (s) => s.discord_roster_category_id,
                  );
                  return channelSync.emitRosterChannelCreated(
                    teamId,
                    updated.id,
                    updated.name,
                    Option.none(),
                    channelName,
                    roleName,
                    discordRoleColor,
                    targetCategoryId,
                  );
                }

                if (isDeactivated) {
                  return Option.isSome(existing.discord_channel_id)
                    ? channelMappings.findByRosterId(teamId, rosterId).pipe(
                        Effect.flatMap(
                          Option.match({
                            onNone: () => Effect.void,
                            onSome: (mapping) => {
                              const cleanupMode = Option.match(settings, {
                                onNone: () => 'delete' as const,
                                onSome: (s) => s.discord_channel_cleanup_on_roster_deactivate,
                              });
                              const archiveCategoryId = Option.flatMap(
                                settings,
                                (s) => s.discord_archive_category_id,
                              );
                              const effectiveMode =
                                cleanupMode === 'archive' && Option.isNone(archiveCategoryId)
                                  ? ('delete' as const)
                                  : cleanupMode;

                              return Match.value(effectiveMode).pipe(
                                Match.when('nothing', () =>
                                  channelSync.emitRosterChannelDetached(
                                    teamId,
                                    rosterId,
                                    existing.name,
                                    mapping.discord_channel_id,
                                    mapping.discord_role_id,
                                  ),
                                ),
                                Match.when('delete', () =>
                                  channelSync.emitRosterChannelDeleted(
                                    teamId,
                                    rosterId,
                                    existing.name,
                                    mapping.discord_channel_id,
                                    mapping.discord_role_id,
                                  ),
                                ),
                                Match.when('archive', () =>
                                  channelSync.emitRosterChannelArchived(
                                    teamId,
                                    rosterId,
                                    existing.name,
                                    mapping.discord_channel_id,
                                    mapping.discord_role_id,
                                    Option.getOrThrow(archiveCategoryId),
                                  ),
                                ),
                                Match.exhaustive,
                                Effect.tap(() =>
                                  channelMappings.deleteByRosterId(teamId, rosterId),
                                ),
                              );
                            },
                          }),
                        ),
                      )
                    : Effect.void;
                }

                if (Option.isNone(settings) || Option.isNone(payload.discordChannelId)) {
                  return Effect.void;
                }

                return Option.match(payload.discordChannelId.value, {
                  onNone: () =>
                    Option.isSome(existing.discord_channel_id)
                      ? channelMappings.findByRosterId(teamId, rosterId).pipe(
                          Effect.flatMap(
                            Option.match({
                              onNone: () => Effect.void,
                              onSome: (mapping) =>
                                Match.value(
                                  settings.value.discord_channel_cleanup_on_roster_deactivate,
                                ).pipe(
                                  Match.when('nothing', () =>
                                    channelSync.emitRosterChannelDetached(
                                      teamId,
                                      rosterId,
                                      existing.name,
                                      mapping.discord_channel_id,
                                      mapping.discord_role_id,
                                    ),
                                  ),
                                  Match.when('delete', () =>
                                    channelSync.emitRosterChannelDeleted(
                                      teamId,
                                      rosterId,
                                      existing.name,
                                      mapping.discord_channel_id,
                                      mapping.discord_role_id,
                                    ),
                                  ),
                                  Match.when('archive', () =>
                                    Option.match(settings.value.discord_archive_category_id, {
                                      onSome: (category) =>
                                        channelSync.emitRosterChannelArchived(
                                          teamId,
                                          rosterId,
                                          existing.name,
                                          mapping.discord_channel_id,
                                          mapping.discord_role_id,
                                          category,
                                        ),
                                      onNone: () => Effect.void,
                                    }),
                                  ),
                                  Match.exhaustive,
                                  Effect.tap(() =>
                                    channelMappings.deleteByRosterId(teamId, rosterId),
                                  ),
                                ),
                            }),
                          ),
                        )
                      : Effect.void,
                  onSome: (channelId) => {
                    const { channelName, roleName, discordRoleColor } = deriveChannelNames(
                      settings,
                      updated.name,
                      updated.emoji,
                      updated.color,
                    );
                    return channelSync.emitRosterChannelCreated(
                      teamId,
                      updated.id,
                      updated.name,
                      Option.some(channelId),
                      channelName,
                      roleName,
                      discordRoleColor,
                      Option.none(),
                    );
                  },
                });
              }),
              Effect.tap(({ existing, updated, settings }) => {
                // Emit channel_updated when name/emoji/color changes but no channel linking change
                const isDeactivated = existing.active === true && updated.active === false;
                const isReactivated = existing.active === false && updated.active === true;
                if (isDeactivated) return Effect.void;
                if (isReactivated) return Effect.void;
                if (Option.isSome(payload.discordChannelId)) return Effect.void;

                const nameChanged = existing.name !== updated.name;
                const emojiChanged =
                  Option.getOrElse(existing.emoji, () => '') !==
                  Option.getOrElse(updated.emoji, () => '');
                const colorChanged =
                  Option.getOrElse(existing.color, () => '') !==
                  Option.getOrElse(updated.color, () => '');
                const anythingChanged = nameChanged || emojiChanged || colorChanged;

                if (!anythingChanged) return Effect.void;

                return channelMappings.findByRosterId(teamId, rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (mapping) =>
                        Option.match(mapping.discord_role_id, {
                          onNone: () => Effect.void,
                          onSome: (discordRoleId) => {
                            const { channelName, roleName, discordRoleColor } = deriveChannelNames(
                              settings,
                              updated.name,
                              updated.emoji,
                              updated.color,
                            );
                            return channelSync.emitRosterChannelUpdated(
                              teamId,
                              rosterId,
                              mapping.discord_channel_id,
                              Option.some(discordRoleId),
                              channelName,
                              roleName,
                              discordRoleColor,
                            );
                          },
                        }),
                    }),
                  ),
                );
              }),
              Effect.bind('memberCount', ({ updated }) =>
                rosters.findMemberEntriesById(updated.id).pipe(Effect.map((e) => e.length)),
              ),
              Effect.bind('team', () =>
                teams
                  .findById(teamId)
                  .pipe(Effect.flatMap(Options.toEffect(() => new Roster.Forbidden()))),
              ),
              Effect.bind('allChannels', ({ team }) =>
                discordChannels.findByGuildId(team.guild_id),
              ),
              Effect.bind('provisioningIds', ({ updated }) =>
                channelSync.hasUnprocessedForRosters([updated.id]),
              ),
              Effect.map(({ updated, memberCount, allChannels, provisioningIds }) =>
                toRosterInfo(updated, memberCount, allChannels, provisioningIds.length > 0),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed updating roster — no row returned'),
              ),
            ),
          )
          .handle('deleteRoster', ({ params: { teamId, rosterId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('existing', () =>
                rosters.findRosterById(rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.RosterNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.bind('mapping', () => channelMappings.findByRosterId(teamId, rosterId)),
              Effect.tap(({ existing, settings, mapping }) =>
                existing.discord_channel_id.pipe(
                  Option.bindTo('channel'),
                  Option.bind('mapping', () => mapping),
                  Option.bind('settings', () => settings),
                  Option.map(({ mapping, settings }) =>
                    Match.value(settings.discord_channel_cleanup_on_roster_deactivate).pipe(
                      Match.when('nothing', () =>
                        channelSync.emitRosterChannelDetached(
                          teamId,
                          rosterId,
                          existing.name,
                          mapping.discord_channel_id,
                          mapping.discord_role_id,
                        ),
                      ),
                      Match.when('delete', () =>
                        channelSync.emitRosterChannelDeleted(
                          teamId,
                          rosterId,
                          existing.name,
                          mapping.discord_channel_id,
                          mapping.discord_role_id,
                        ),
                      ),
                      Match.when('archive', () =>
                        Option.match(settings.discord_archive_category_id, {
                          onSome: (category) =>
                            channelSync.emitRosterChannelArchived(
                              teamId,
                              rosterId,
                              existing.name,
                              mapping.discord_channel_id,
                              mapping.discord_role_id,
                              category,
                            ),
                          onNone: () => Effect.void,
                        }),
                      ),
                      Match.exhaustive,
                    ),
                  ),
                  Option.getOrElse(() => Effect.void),
                ),
              ),
              Effect.tap(() => rosters.delete(rosterId)),
              Effect.asVoid,
            ),
          )
          .handle('addRosterMember', ({ params: { teamId, rosterId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('_roster', () =>
                rosters.findRosterById(rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.RosterNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('_member', () =>
                members.findRosterMemberByIds(teamId, payload.memberId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() => rosters.addMemberById(rosterId, payload.memberId)),
              Effect.tap(({ _roster, _member }) =>
                users.findById(_member.user_id).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (user) =>
                        channelSync.emitRosterMemberAdded(
                          teamId,
                          rosterId,
                          _roster.name,
                          payload.memberId,
                          Option.some(user.discord_id),
                        ),
                    }),
                  ),
                ),
              ),
              Effect.asVoid,
            ),
          )
          .handle('removeRosterMember', ({ params: { teamId, rosterId, memberId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('_roster', () =>
                rosters.findRosterById(rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.RosterNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('_member', () =>
                members.findRosterMemberByIds(teamId, memberId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() => rosters.removeMemberById(rosterId, memberId)),
              Effect.tap(({ _roster, _member }) =>
                users.findById(_member.user_id).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (user) =>
                        channelSync.emitRosterMemberRemoved(
                          teamId,
                          rosterId,
                          _roster.name,
                          memberId,
                          Option.some(user.discord_id),
                        ),
                    }),
                  ),
                ),
              ),
              Effect.asVoid,
            ),
          )
          .handle('createChannel', ({ params: { teamId, rosterId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('roster', () =>
                rosters.findRosterById(rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.RosterNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ roster, settings }) => {
                const { channelName, roleName, discordRoleColor } = deriveChannelNames(
                  settings,
                  roster.name,
                  roster.emoji,
                  roster.color,
                );
                return channelSync.emitRosterChannelCreated(
                  teamId,
                  roster.id,
                  roster.name,
                  Option.none(),
                  channelName,
                  roleName,
                  discordRoleColor,
                  Option.flatMap(settings, (s) => s.discord_roster_category_id),
                );
              }),
              Effect.asVoid,
            ),
          )
          .handle('syncRoleMembers', ({ params: { teamId, rosterId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('roster', () =>
                rosters.findRosterById(rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.RosterNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ roster }) =>
                roster.team_id !== teamId ? Effect.fail(new Roster.RosterNotFound()) : Effect.void,
              ),
              Effect.bind('rosterMembers', () => rosters.findMemberEntriesById(rosterId)),
              Effect.bind('mapping', () => channelMappings.findByRosterId(teamId, rosterId)),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ roster, mapping, settings }) => {
                const { channelName, roleName, discordRoleColor } = deriveChannelNames(
                  settings,
                  roster.name,
                  roster.emoji,
                  roster.color,
                );
                const existingChannelId = Option.flatMap(mapping, (m) => m.discord_channel_id);
                return channelSync.emitRosterChannelCreated(
                  teamId,
                  rosterId,
                  roster.name,
                  existingChannelId,
                  channelName,
                  roleName,
                  discordRoleColor,
                  Option.flatMap(settings, (s) => s.discord_roster_category_id),
                );
              }),
              Effect.map(
                ({ rosterMembers }) =>
                  new Roster.SyncRoleMembersResult({
                    addedCount: rosterMembers.length,
                    removedCount: 0,
                    skippedCount: 0,
                  }),
              ),
            ),
          )
          // backfillRosterRoles reuses roster:manage — same permission cluster as createRoster,
          // updateRoster, and syncRoleMembers; backfill is an admin-only bulk operation.
          .handle('backfillRosterRoles', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', new Roster.Forbidden()),
              ),
              Effect.bind('backfill', () => backfillRosterRoleMembers(teamId)),
              Effect.bind('reconcile', () => reconcileRosterRoleExtras(teamId)),
              Effect.map(
                ({ backfill, reconcile }) =>
                  new Roster.BackfillRosterRolesResult({
                    processedCount: backfill.processedCount + reconcile.processedCount,
                    remainingCount: backfill.remainingCount + reconcile.remainingCount,
                  }),
              ),
            ),
          ),
    ),
  ),
);
