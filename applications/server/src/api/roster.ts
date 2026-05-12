import { Auth, type Discord, Roster, type RosterModel } from '@sideline/domain';
import { LogicError, Options } from '@sideline/effect-lib';
import { Array, DateTime, Effect, Match, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
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
import { hexColorToDiscordInt } from '~/utils/hexColorToDiscordInt.js';

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
  });

type ChannelLike = { readonly channel_id: Discord.Snowflake; readonly name: string };

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

export const RosterApiLive = HttpApiBuilder.group(Api, 'roster', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('users', () => UsersRepository.asEffect()),
    Effect.bind('rosters', () => RostersRepository.asEffect()),
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
        teams,
        discordChannels,
        channelSync,
        teamSettings,
        channelMappings,
      }) =>
        handlers
          .handle('listMembers', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
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
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'member:view', new Roster.Forbidden()),
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
              Effect.bind('_check', () =>
                members.findRosterMemberByIds(teamId, memberId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Roster.PlayerNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() => members.deactivateMemberByIds(teamId, memberId)),
              Effect.asVoid,
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed deactivating roster member — no row returned'),
              ),
            ),
          )
          .handle('listRosters', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
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
                const channelName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_CHANNEL_FORMAT,
                    onSome: (s) => s.discord_channel_format,
                  }),
                  roster.name,
                  roster.emoji,
                );
                const roleName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_ROLE_FORMAT,
                    onSome: (s) => s.discord_role_format,
                  }),
                  roster.name,
                  roster.emoji,
                );
                const discordRoleColor = Option.map(roster.color, hexColorToDiscordInt);
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
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, new Roster.Forbidden()),
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
                const isDeactivated = existing.active === true && updated.active === false;

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
                    return channelSync.emitRosterChannelCreated(
                      teamId,
                      updated.id,
                      updated.name,
                      Option.some(channelId),
                      channelName,
                      roleName,
                      discordRoleColor,
                    );
                  },
                });
              }),
              Effect.tap(({ existing, updated, settings }) => {
                // Emit channel_updated when name/emoji/color changes but no channel linking change
                const isDeactivated = existing.active === true && updated.active === false;
                if (isDeactivated) return Effect.void;
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
                            const discordRoleColor = Option.map(
                              updated.color,
                              hexColorToDiscordInt,
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
                          user.discord_id,
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
                          user.discord_id,
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
                const channelName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_CHANNEL_FORMAT,
                    onSome: (s) => s.discord_channel_format,
                  }),
                  roster.name,
                  roster.emoji,
                );
                const roleName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_ROLE_FORMAT,
                    onSome: (s) => s.discord_role_format,
                  }),
                  roster.name,
                  roster.emoji,
                );
                const discordRoleColor = Option.map(roster.color, hexColorToDiscordInt);
                return channelSync.emitRosterChannelCreated(
                  teamId,
                  roster.id,
                  roster.name,
                  Option.none(),
                  channelName,
                  roleName,
                  discordRoleColor,
                );
              }),
              Effect.asVoid,
            ),
          ),
    ),
  ),
);
