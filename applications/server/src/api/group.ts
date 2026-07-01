import { Auth, DisplayName, GroupApi } from '@sideline/domain';
import { LogicError, Options } from '@sideline/effect-lib';
import { Array, Effect, Match, Option, pipe, Result } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission, requireReadAccess } from '~/api/permissions.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import {
  applyDiscordFormat,
  DEFAULT_CHANNEL_FORMAT,
  DEFAULT_ROLE_FORMAT,
} from '~/utils/applyDiscordFormat.js';
import { hexColorToDiscordInt } from '~/utils/hexColorToDiscordInt.js';

const forbidden = new GroupApi.Forbidden();

export const GroupApiLive = HttpApiBuilder.group(Api, 'group', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('roles', () => RolesRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('users', () => UsersRepository.asEffect()),
    Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('discordChannels', () => DiscordChannelsRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('discordRoles', () => DiscordRolesRepository.asEffect()),
    Effect.map(
      ({
        members,
        groups,
        roles,
        channelSync,
        users,
        channelMappings,
        teams,
        discordChannels,
        teamSettings,
        discordRoles,
      }) =>
        handlers
          .handle('listGroups', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('list', () => groups.findGroupsByTeamId(teamId)),
              Effect.bind('provisioningIds', ({ list }) =>
                channelSync.hasUnprocessedForGroups(list.map((g) => g.id)),
              ),
              Effect.map(({ list, provisioningIds }) => {
                const provisioningSet = new Set(provisioningIds);
                return Array.map(
                  list,
                  (g) =>
                    new GroupApi.GroupInfo({
                      groupId: g.id,
                      teamId: g.team_id,
                      parentId: g.parent_id,
                      name: g.name,
                      emoji: g.emoji,
                      color: g.color,
                      memberCount: g.member_count,
                      discordChannelProvisioning: provisioningSet.has(g.id),
                    }),
                );
              }),
            ),
          )
          .handle('listMemberGroups', ({ params: { teamId, memberId } }) =>
            Effect.Do.pipe(
              Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:view', forbidden),
              ),
              Effect.bind('_check', () =>
                members.findRosterMemberByIds(teamId, memberId, { includeInactive: true }).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.MemberNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('memberGroupIds', () => groups.findGroupIdsByMember(memberId)),
              Effect.bind('list', () => groups.findGroupsByTeamId(teamId)),
              Effect.let('memberGroups', ({ list, memberGroupIds }) => {
                const memberGroupIdSet = new Set(memberGroupIds);
                return list.filter((g) => memberGroupIdSet.has(g.id));
              }),
              Effect.bind('provisioningIds', ({ memberGroups }) =>
                channelSync.hasUnprocessedForGroups(memberGroups.map((g) => g.id)),
              ),
              Effect.map(({ memberGroups, provisioningIds }) => {
                const provisioningSet = new Set(provisioningIds);
                return Array.map(
                  memberGroups,
                  (g) =>
                    new GroupApi.GroupInfo({
                      groupId: g.id,
                      teamId: g.team_id,
                      parentId: g.parent_id,
                      name: g.name,
                      emoji: g.emoji,
                      color: g.color,
                      memberCount: g.member_count,
                      discordChannelProvisioning: provisioningSet.has(g.id),
                    }),
                );
              }),
            ),
          )
          .handle('createGroup', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('group', () =>
                groups.insertGroup(
                  teamId,
                  payload.name,
                  payload.parentId,
                  payload.emoji,
                  payload.color,
                ),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ group, settings }) => {
                const channelName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_CHANNEL_FORMAT,
                    onSome: (s) => s.discord_channel_format,
                  }),
                  group.name,
                  group.emoji,
                );
                const roleName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_ROLE_FORMAT,
                    onSome: (s) => s.discord_role_format,
                  }),
                  group.name,
                  group.emoji,
                );
                const discordRoleColor = Option.map(group.color, hexColorToDiscordInt);
                const createChannel = Option.match(settings, {
                  onNone: () => true,
                  onSome: (s) => s.create_discord_channel_on_group,
                });
                return channelSync.emitChannelCreated(
                  teamId,
                  group.id,
                  group.name,
                  Option.none(),
                  createChannel ? channelName : undefined,
                  roleName,
                  discordRoleColor,
                );
              }),
              Effect.map(
                ({ group }) =>
                  new GroupApi.GroupInfo({
                    groupId: group.id,
                    teamId: group.team_id,
                    parentId: group.parent_id,
                    name: group.name,
                    emoji: group.emoji,
                    color: group.color,
                    memberCount: 0,
                    discordChannelProvisioning: true,
                  }),
              ),
              Effect.catchTag('GroupNameAlreadyTakenError', () =>
                Effect.fail(new GroupApi.GroupNameAlreadyTaken()),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(
                  () => `Failed creating group "${payload.name}" — no row returned`,
                ),
              ),
            ),
          )
          .handle('getGroup', ({ params: { teamId, groupId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ group }) =>
                group.team_id !== teamId ? Effect.fail(new GroupApi.GroupNotFound()) : Effect.void,
              ),
              Effect.bind('groupMembers', () => groups.findMembersByGroupId(groupId)),
              Effect.bind('groupRoles', () => groups.getRolesForGroup(groupId)),
              Effect.bind('provisioningIds', () => channelSync.hasUnprocessedForGroups([groupId])),
              Effect.map(
                ({ group, groupMembers, groupRoles, provisioningIds }) =>
                  new GroupApi.GroupDetail({
                    groupId: group.id,
                    teamId: group.team_id,
                    parentId: group.parent_id,
                    name: group.name,
                    emoji: group.emoji,
                    color: group.color,
                    discordChannelProvisioning: provisioningIds.length > 0,
                    roles: Array.map(groupRoles, (r) => ({
                      roleId: r.role_id,
                      roleName: r.role_name,
                    })),
                    members: Array.map(groupMembers, (m) => ({
                      memberId: m.member_id,
                      name: m.name,
                      username: m.username,
                      displayName: Option.getOrElse(
                        DisplayName.pickDisplayName({
                          name: m.name,
                          nickname: m.nickname,
                          displayName: m.display_name,
                          username: Option.some(m.username),
                        }),
                        () => m.username,
                      ),
                    })),
                  }),
              ),
            ),
          )
          .handle('updateGroup', ({ params: { teamId, groupId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('existing', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ existing }) =>
                existing.team_id !== teamId
                  ? Effect.fail(new GroupApi.GroupNotFound())
                  : Effect.void,
              ),
              Effect.bind('updated', () =>
                groups.updateGroupById(groupId, payload.name, payload.emoji, payload.color),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.bind('mapping', () => channelMappings.findByGroupId(teamId, groupId)),
              Effect.tap(({ existing, updated, settings, mapping }) => {
                const nameChanged = existing.name !== updated.name;
                const emojiChanged =
                  Option.getOrElse(existing.emoji, () => '') !==
                  Option.getOrElse(updated.emoji, () => '');
                const colorChanged =
                  Option.getOrElse(existing.color, () => '') !==
                  Option.getOrElse(updated.color, () => '');
                const anythingChanged = nameChanged || emojiChanged || colorChanged;
                return anythingChanged
                  ? Option.match(mapping, {
                      onNone: () => Effect.void,
                      onSome: (m) => {
                        const channelName = applyDiscordFormat(
                          Option.match(settings, {
                            onNone: () => DEFAULT_CHANNEL_FORMAT,
                            onSome: (s) => s.discord_channel_format,
                          }),
                          updated.name,
                          updated.emoji,
                        );
                        const roleName = applyDiscordFormat(
                          Option.match(settings, {
                            onNone: () => DEFAULT_ROLE_FORMAT,
                            onSome: (s) => s.discord_role_format,
                          }),
                          updated.name,
                          updated.emoji,
                        );
                        const discordRoleColor = Option.map(updated.color, hexColorToDiscordInt);
                        return channelSync.emitGroupChannelUpdated(
                          teamId,
                          groupId,
                          m.discord_channel_id,
                          m.discord_role_id,
                          channelName,
                          roleName,
                          discordRoleColor,
                        );
                      },
                    })
                  : Effect.void;
              }),
              Effect.bind('memberCount', () => groups.getMemberCount(groupId)),
              Effect.bind('provisioningIds', () => channelSync.hasUnprocessedForGroups([groupId])),
              Effect.map(
                ({ updated, memberCount, provisioningIds }) =>
                  new GroupApi.GroupInfo({
                    groupId: updated.id,
                    teamId: updated.team_id,
                    parentId: updated.parent_id,
                    name: updated.name,
                    emoji: updated.emoji,
                    color: updated.color,
                    memberCount,
                    discordChannelProvisioning: provisioningIds.length > 0,
                  }),
              ),
              Effect.catchTag('GroupNameAlreadyTakenError', () =>
                Effect.fail(new GroupApi.GroupNameAlreadyTaken()),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => `Failed updating group ${groupId} — no row returned`),
              ),
            ),
          )
          .handle('deleteGroup', ({ params: { teamId, groupId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('existing', () =>
                groups
                  .findGroupById(groupId)
                  .pipe(Effect.flatMap(Options.toEffect(() => new GroupApi.GroupNotFound()))),
              ),
              Effect.tap(({ existing }) =>
                existing.team_id !== teamId
                  ? Effect.fail(new GroupApi.GroupNotFound()).pipe(
                      Effect.tapError(() =>
                        Effect.logWarning(
                          `Tried to delete group ${groupId} of team ${teamId}, but it actually belongs to ${existing.team_id}`,
                        ),
                      ),
                    )
                  : Effect.void,
              ),
              Effect.bind('mapping', () => channelMappings.findByGroupId(teamId, groupId)),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(() => groups.archiveGroupById(groupId)),
              Effect.tap(({ existing, mapping, settings }) =>
                Option.match(mapping, {
                  onNone: () => Effect.void,
                  onSome: (mapping) =>
                    Match.value(
                      Option.match(settings, {
                        onNone: () => 'delete' as const,
                        onSome: (s) => s.discord_channel_cleanup_on_group_delete,
                      }),
                    ).pipe(
                      Match.when('nothing', () =>
                        channelMappings
                          .clearGroupChannel(teamId, groupId)
                          .pipe(
                            Effect.tap(() =>
                              channelSync.emitChannelDetached(
                                teamId,
                                groupId,
                                existing.name,
                                mapping.discord_channel_id,
                                mapping.discord_role_id,
                              ),
                            ),
                          ),
                      ),
                      Match.when('delete', () =>
                        channelSync.emitChannelDeleted(
                          teamId,
                          groupId,
                          existing.name,
                          mapping.discord_channel_id,
                          mapping.discord_role_id,
                        ),
                      ),
                      Match.when('archive', () =>
                        Option.flatMap(settings, (s) => s.discord_archive_category_id).pipe(
                          Option.match({
                            onSome: (category) =>
                              channelMappings
                                .clearGroupChannel(teamId, groupId)
                                .pipe(
                                  Effect.tap(() =>
                                    channelSync.emitChannelArchived(
                                      teamId,
                                      groupId,
                                      existing.name,
                                      mapping.discord_channel_id,
                                      mapping.discord_role_id,
                                      category,
                                    ),
                                  ),
                                ),
                            onNone: () => Effect.void,
                          }),
                        ),
                      ),
                      Match.exhaustive,
                    ),
                }),
              ),
              Effect.asVoid,
            ),
          )
          .handle('addGroupMember', ({ params: { teamId, groupId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('_group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.bind('_member', () =>
                members.findRosterMemberByIds(teamId, payload.memberId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.MemberNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() => groups.addMemberById(groupId, payload.memberId)),
              Effect.tap(({ _group, _member }) =>
                users.findById(_member.user_id).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (user) =>
                        Effect.all(
                          [
                            channelSync.emitMemberAdded(
                              teamId,
                              groupId,
                              _group.name,
                              payload.memberId,
                              user.discord_id,
                            ),
                            groups
                              .getAncestors(groupId)
                              .pipe(
                                Effect.flatMap((ancestors) =>
                                  Effect.forEach(ancestors, (ancestor) =>
                                    channelSync.emitMemberAdded(
                                      teamId,
                                      ancestor.id,
                                      ancestor.name,
                                      payload.memberId,
                                      user.discord_id,
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
              ),
              Effect.asVoid,
            ),
          )
          .handle('removeGroupMember', ({ params: { teamId, groupId, memberId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('_group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.bind('_member', () =>
                members.findRosterMemberByIds(teamId, memberId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.MemberNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() => groups.removeMemberById(groupId, memberId)),
              Effect.tap(({ _group, _member }) =>
                users.findById(_member.user_id).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (user) =>
                        channelSync.emitMemberRemoved(
                          teamId,
                          groupId,
                          _group.name,
                          memberId,
                          user.discord_id,
                        ),
                    }),
                  ),
                ),
              ),
              Effect.asVoid,
            ),
          )
          .handle('assignGroupRole', ({ params: { teamId, groupId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('_group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.tap(() => roles.assignRoleToGroup(payload.roleId, groupId)),
              Effect.asVoid,
            ),
          )
          .handle('unassignGroupRole', ({ params: { teamId, groupId, roleId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('_group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.tap(() => roles.unassignRoleFromGroup(roleId, groupId)),
              Effect.asVoid,
            ),
          )
          .handle('moveGroup', ({ params: { teamId, groupId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('existing', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              // Validate no circular refs if moving to a new parent
              Effect.tap(() =>
                Option.match(payload.parentId, {
                  onNone: () => Effect.void,
                  onSome: (pid) =>
                    groups
                      .getAncestorIds(pid)
                      .pipe(
                        Effect.flatMap((ancestors) =>
                          pipe(ancestors, Array.contains(groupId))
                            ? Effect.fail(forbidden)
                            : Effect.void,
                        ),
                      ),
                }),
              ),
              Effect.bind('updated', () => groups.moveGroup(groupId, payload.parentId)),
              Effect.bind('memberCount', () => groups.getMemberCount(groupId)),
              Effect.bind('provisioningIds', () => channelSync.hasUnprocessedForGroups([groupId])),
              Effect.map(
                ({ updated, memberCount, provisioningIds }) =>
                  new GroupApi.GroupInfo({
                    groupId: updated.id,
                    teamId: updated.team_id,
                    parentId: updated.parent_id,
                    name: updated.name,
                    emoji: updated.emoji,
                    color: updated.color,
                    memberCount,
                    discordChannelProvisioning: provisioningIds.length > 0,
                  }),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => `Failed moving group ${groupId} — no row returned`),
              ),
            ),
          )
          .handle('getChannelMapping', ({ params: { teamId, groupId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('_group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.bind('mapping', () => channelMappings.findByGroupId(teamId, groupId)),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(Effect.flatMap(Options.toEffect(() => forbidden))),
              ),
              Effect.bind('allChannels', ({ team }) =>
                discordChannels.findByGuildId(team.guild_id),
              ),
              Effect.map(({ mapping, allChannels }) =>
                Option.match(mapping, {
                  onNone: () => Option.none(),
                  onSome: (row) =>
                    Option.some(
                      new GroupApi.ChannelMappingInfo({
                        discordChannelId: row.discord_channel_id,
                        discordChannelName: Option.flatMap(row.discord_channel_id, (channelId) =>
                          Option.fromNullishOr(
                            allChannels.find((ch) => ch.channel_id === channelId)?.name ?? null,
                          ),
                        ),
                        discordRoleId: row.discord_role_id,
                      }),
                    ),
                }),
              ),
            ),
          )
          .handle('setChannelMapping', ({ params: { teamId, groupId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('_group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.tap(() =>
                channelMappings
                  .findAllByTeam(teamId)
                  .pipe(
                    Effect.flatMap((mappings) =>
                      mappings.some(
                        (m) =>
                          Option.isSome(m.discord_channel_id) &&
                          m.discord_channel_id.value === payload.discordChannelId,
                      )
                        ? Effect.fail(forbidden)
                        : Effect.void,
                    ),
                  ),
              ),
              Effect.tap(() =>
                channelMappings.upsertGroupChannel(teamId, groupId, payload.discordChannelId),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ _group, settings }) => {
                const channelName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_CHANNEL_FORMAT,
                    onSome: (s) => s.discord_channel_format,
                  }),
                  _group.name,
                  _group.emoji,
                );
                const roleName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_ROLE_FORMAT,
                    onSome: (s) => s.discord_role_format,
                  }),
                  _group.name,
                  _group.emoji,
                );
                const discordRoleColor = Option.map(_group.color, hexColorToDiscordInt);
                return channelSync.emitChannelCreated(
                  teamId,
                  groupId,
                  _group.name,
                  Option.some(payload.discordChannelId),
                  channelName,
                  roleName,
                  discordRoleColor,
                );
              }),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(Effect.flatMap(Options.toEffect(() => forbidden))),
              ),
              Effect.bind('allChannels', ({ team }) =>
                discordChannels.findByGuildId(team.guild_id),
              ),
              Effect.map(
                ({ allChannels }) =>
                  new GroupApi.ChannelMappingInfo({
                    discordChannelId: Option.some(payload.discordChannelId),
                    discordChannelName: Option.fromNullishOr(
                      allChannels.find((ch) => ch.channel_id === payload.discordChannelId)?.name ??
                        null,
                    ),
                    discordRoleId: Option.none(),
                  }),
              ),
            ),
          )
          .handle('deleteChannelMapping', ({ params: { teamId, groupId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('_group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.bind('mapping', () =>
                channelMappings.findByGroupId(teamId, groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ _group, mapping, settings }) =>
                Match.value(
                  Option.match(settings, {
                    onNone: () => 'delete' as const,
                    onSome: (s) => s.discord_channel_cleanup_on_group_delete,
                  }),
                ).pipe(
                  Match.when('nothing', () =>
                    channelMappings
                      .clearGroupChannel(teamId, groupId)
                      .pipe(
                        Effect.tap(() =>
                          channelSync.emitChannelDetached(
                            teamId,
                            groupId,
                            _group.name,
                            mapping.discord_channel_id,
                            mapping.discord_role_id,
                          ),
                        ),
                      ),
                  ),
                  Match.when('delete', () =>
                    channelSync.emitChannelDeleted(
                      teamId,
                      groupId,
                      _group.name,
                      mapping.discord_channel_id,
                      mapping.discord_role_id,
                    ),
                  ),
                  Match.when('archive', () =>
                    Option.flatMap(settings, (s) => s.discord_archive_category_id).pipe(
                      Option.match({
                        onSome: (category) =>
                          channelMappings
                            .clearGroupChannel(teamId, groupId)
                            .pipe(
                              Effect.tap(() =>
                                channelSync.emitChannelArchived(
                                  teamId,
                                  groupId,
                                  _group.name,
                                  mapping.discord_channel_id,
                                  mapping.discord_role_id,
                                  category,
                                ),
                              ),
                            ),
                        onNone: () => Effect.void,
                      }),
                    ),
                  ),
                  Match.exhaustive,
                ),
              ),
              Effect.asVoid,
            ),
          )
          .handle('createChannel', ({ params: { teamId, groupId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: (g) =>
                        g.team_id !== teamId
                          ? Effect.fail(new GroupApi.GroupNotFound())
                          : Effect.succeed(g),
                    }),
                  ),
                ),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ group, settings }) => {
                const channelName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_CHANNEL_FORMAT,
                    onSome: (s) => s.discord_channel_format,
                  }),
                  group.name,
                  group.emoji,
                );
                const roleName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_ROLE_FORMAT,
                    onSome: (s) => s.discord_role_format,
                  }),
                  group.name,
                  group.emoji,
                );
                const discordRoleColor = Option.map(group.color, hexColorToDiscordInt);
                return channelSync.emitChannelCreated(
                  teamId,
                  groupId,
                  group.name,
                  Option.none(),
                  channelName,
                  roleName,
                  discordRoleColor,
                );
              }),
              Effect.asVoid,
            ),
          )
          .handle('syncRoleMembers', ({ params: { teamId, groupId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('group', () =>
                groups.findGroupById(groupId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ group }) =>
                group.team_id !== teamId ? Effect.fail(new GroupApi.GroupNotFound()) : Effect.void,
              ),
              Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
              Effect.flatMap(({ group, sql }) =>
                sql
                  .withTransaction(
                    Effect.Do.pipe(
                      Effect.bind('ancestors', () => groups.getAncestors(groupId)),
                      Effect.bind('groupMembers', () =>
                        groups.findMembersWithDiscordIdByGroupId(groupId),
                      ),
                      Effect.bind('roster', () => members.findRosterByTeam(teamId)),
                      Effect.let('linked', ({ groupMembers }) =>
                        Array.filterMap(groupMembers, (m) =>
                          m.discordUserId !== null
                            ? Result.succeed({
                                teamMemberId: m.teamMemberId,
                                discordUserId: m.discordUserId,
                              })
                            : Result.failVoid,
                        ),
                      ),
                      Effect.let('extras', ({ groupMembers, roster }) => {
                        const groupMemberIdSet = new Set(groupMembers.map((m) => m.teamMemberId));
                        return roster.filter((r) => !groupMemberIdSet.has(r.member_id));
                      }),
                      Effect.let('addEntries', ({ ancestors, linked }) => {
                        const allGroups = [group, ...ancestors];
                        return linked.flatMap((m) =>
                          allGroups.map((g) => ({
                            groupId: g.id,
                            groupName: g.name,
                            teamMemberId: m.teamMemberId,
                            discordUserId: m.discordUserId,
                          })),
                        );
                      }),
                      Effect.let('removeEntries', ({ extras }) =>
                        extras.map((r) => ({
                          groupId,
                          groupName: group.name,
                          teamMemberId: r.member_id,
                          discordUserId: r.discord_id,
                        })),
                      ),
                      Effect.tap(({ addEntries }) =>
                        channelSync.emitMembersAddedBatch({ teamId, entries: addEntries }),
                      ),
                      Effect.tap(({ removeEntries }) =>
                        channelSync.emitMembersRemovedBatch({ teamId, entries: removeEntries }),
                      ),
                      Effect.map(
                        ({ groupMembers, linked, extras }) =>
                          new GroupApi.SyncRoleMembersResult({
                            addedCount: linked.length,
                            removedCount: extras.length,
                            skippedCount: groupMembers.length - linked.length,
                          }),
                      ),
                    ),
                  )
                  .pipe(catchSqlErrors),
              ),
            ),
          )
          .handle('listDiscordChannels', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(Effect.flatMap(Options.toEffect(() => forbidden))),
              ),
              Effect.bind('channels', ({ team }) => discordChannels.findByGuildId(team.guild_id)),
              Effect.bind('mappings', () => channelMappings.findAllByTeam(teamId)),
              Effect.map(({ channels, mappings }) => {
                const mappedChannelIds = new Set(
                  mappings.flatMap((m) =>
                    Option.isSome(m.discord_channel_id) ? [m.discord_channel_id.value] : [],
                  ),
                );
                return Array.filterMap(channels, (ch) =>
                  mappedChannelIds.has(ch.channel_id)
                    ? Result.failVoid
                    : Result.succeed(
                        new GroupApi.DiscordChannelInfo({
                          id: ch.channel_id,
                          name: ch.name,
                          type: ch.type,
                          parentId: ch.parent_id,
                        }),
                      ),
                );
              }),
            ),
          )
          .handle('listDiscordRoles', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(Effect.flatMap(Options.toEffect(() => forbidden))),
              ),
              Effect.bind('roles', ({ team }) => discordRoles.listByGuild(team.guild_id)),
              Effect.map(({ roles: roleRows }) =>
                roleRows.map(
                  (r) =>
                    new GroupApi.DiscordRoleInfo({
                      id: r.id,
                      name: r.name,
                      color: r.color,
                      position: r.position,
                      managed: r.managed,
                    }),
                ),
              ),
            ),
          ),
    ),
  ),
);
