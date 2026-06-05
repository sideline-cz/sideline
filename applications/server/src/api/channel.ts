import {
  Auth,
  ChannelApi,
  type Discord,
  type GroupModel,
  type TeamChannel,
  type TeamChannelAccess,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, Effect, Exit, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { applyDiscordFormat, DEFAULT_CHANNEL_FORMAT } from '~/utils/applyDiscordFormat.js';
import { buildManagedAccessGrantEntries } from '~/utils/managedAccessEntries.js';

const forbidden = new ChannelApi.ChannelForbidden();

const toChannelDetail = (
  channel: {
    readonly id: TeamChannel.TeamChannelId;
    readonly name: string;
    readonly category: Option.Option<string>;
    readonly archived: boolean;
    readonly discord_channel_id: Option.Option<Discord.Snowflake>;
  },
  accessCount: number,
  grants: ReadonlyArray<{
    group_id: GroupModel.GroupId;
    access_level: TeamChannelAccess.AccessLevel;
  }>,
  emoji: Option.Option<string> = Option.none(),
): ChannelApi.ChannelDetail =>
  new ChannelApi.ChannelDetail({
    discordChannelId: channel.discord_channel_id,
    teamChannelId: Option.some(channel.id),
    name: channel.name,
    emoji,
    category: channel.category,
    managed: true,
    type: 0,
    archived: channel.archived,
    accessCount,
    grants: grants.map(
      (g) =>
        new ChannelApi.ChannelAccessGrant({
          groupId: g.group_id,
          accessLevel: g.access_level,
        }),
    ),
  });

export const ChannelApiLive = HttpApiBuilder.group(Api, 'channel', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('channels', () => TeamChannelsRepository.asEffect()),
    Effect.bind('channelAccess', () => TeamChannelAccessRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('botGuilds', () => BotGuildsRepository.asEffect()),
    Effect.bind('discordChannels', () => DiscordChannelsRepository.asEffect()),
    Effect.map(
      ({
        members,
        channels,
        channelAccess,
        channelSync,
        teams,
        teamSettings,
        botGuilds,
        discordChannels,
      }) =>
        handlers
          .handle('listChannels', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.let('canManage', ({ membership }) =>
                hasPermission(membership, 'group:manage'),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(forbidden),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('guildLinked', ({ team }) => botGuilds.exists(team.guild_id)),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.let('archiveCategoryId', ({ settings }) =>
                Option.flatMap(settings, (s) => s.discord_archive_category_id),
              ),
              Effect.bind('discordRows', ({ guildLinked }) =>
                guildLinked ? discordChannels.findManagedListByTeam(teamId) : Effect.succeed([]),
              ),
              // Build a Map<channelId, name> for type=4 (category) rows to resolve parent names
              Effect.let('categoryNameMap', ({ discordRows }) => {
                const m = new Map<Discord.Snowflake, string>();
                for (const row of discordRows) {
                  if (row.type === 4) m.set(row.channel_id, row.name);
                }
                return m;
              }),
              // Build set of discord channel ids that are already represented in discordRows
              Effect.let('discordChannelIdSet', ({ discordRows }) => {
                const s = new Set<Discord.Snowflake>();
                for (const row of discordRows) {
                  s.add(row.channel_id);
                }
                return s;
              }),
              // Fetch all managed team_channels for the merge step
              Effect.bind('managedChannels', () => channels.findAllByTeam(teamId)),
              // For managed channels we need access counts
              Effect.bind('managedAccessCounts', ({ managedChannels }) =>
                Effect.forEach(
                  managedChannels,
                  (ch) =>
                    channelAccess
                      .countByChannel(ch.id)
                      .pipe(Effect.map((count) => [ch.id, count] as const)),
                  { concurrency: 'unbounded' },
                ).pipe(Effect.map((pairs) => new Map(pairs))),
              ),
              Effect.map(
                ({
                  canManage,
                  guildLinked,
                  archiveCategoryId,
                  settings,
                  discordRows,
                  categoryNameMap,
                  discordChannelIdSet,
                  managedChannels,
                  managedAccessCounts,
                }) => {
                  const channelFormat = Option.match(settings, {
                    onNone: () => DEFAULT_CHANNEL_FORMAT,
                    onSome: (s) => s.discord_channel_format,
                  });

                  // Build ChannelInfo items from discord_channels rows
                  const discordInfos: ChannelApi.ChannelInfo[] = discordRows.map(
                    (row) =>
                      new ChannelApi.ChannelInfo({
                        discordChannelId: Option.some(row.channel_id),
                        teamChannelId: row.team_channel_id,
                        // For managed rows (team_channel_id present), use the team_channel_name
                        // as the display name (falls back to discord name if not set)
                        name: Option.isSome(row.team_channel_id)
                          ? Option.getOrElse(row.team_channel_name, () => row.name)
                          : row.name,
                        emoji: Option.isSome(row.team_channel_id)
                          ? row.team_channel_emoji
                          : Option.none(),
                        category: Option.flatMap(row.parent_id, (pid) =>
                          Option.fromNullishOr(categoryNameMap.get(pid)),
                        ),
                        managed: Option.isSome(row.team_channel_id),
                        type: row.type,
                        // For managed channels (team_channel_archived is set), that flag is the
                        // single source of truth so that mid-sync disagreements between
                        // parent_id and team_channels.archived don't produce split results.
                        archived: Option.match(row.team_channel_archived, {
                          onSome: (tcArchived) =>
                            tcArchived ||
                            Option.match(archiveCategoryId, {
                              onNone: () => false,
                              onSome: (catId) =>
                                Option.match(row.parent_id, {
                                  onNone: () => false,
                                  onSome: (pid) => pid === catId,
                                }),
                            }),
                          onNone: () =>
                            Option.match(archiveCategoryId, {
                              onNone: () => false,
                              onSome: (catId) =>
                                Option.match(row.parent_id, {
                                  onNone: () => false,
                                  onSome: (pid) => pid === catId,
                                }),
                            }),
                        }),
                        accessCount: Number(row.access_count),
                      }),
                  );

                  // Merge: include managed team_channels rows whose discord_channel_id is None
                  // or whose discord_channel_id is not present in discordChannelIdSet
                  const mergedInfos: ChannelApi.ChannelInfo[] = [];
                  for (const ch of managedChannels) {
                    const dcId = ch.discord_channel_id;
                    const alreadyIncluded = Option.match(dcId, {
                      onNone: () => false,
                      onSome: (id) => discordChannelIdSet.has(id),
                    });
                    if (!alreadyIncluded) {
                      mergedInfos.push(
                        new ChannelApi.ChannelInfo({
                          discordChannelId: ch.discord_channel_id,
                          teamChannelId: Option.some(ch.id),
                          name: ch.name,
                          emoji: ch.emoji,
                          category: ch.category,
                          managed: true,
                          type: 0,
                          archived: ch.archived,
                          accessCount: managedAccessCounts.get(ch.id) ?? 0,
                        }),
                      );
                    }
                  }

                  const allChannels = [...discordInfos, ...mergedInfos].sort((a, b) => {
                    const catA = Option.getOrElse(a.category, () => '');
                    const catB = Option.getOrElse(b.category, () => '');
                    if (catA !== catB) return catA.localeCompare(catB);
                    return a.name.localeCompare(b.name);
                  });

                  return new ChannelApi.ChannelListResponse({
                    canManage,
                    guildLinked,
                    archiveCategoryId,
                    channelFormat,
                    channels: allChannels,
                  });
                },
              ),
            ),
          )
          .handle('createChannel', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.bind('channel', () =>
                channels.insert(teamId, payload.name, payload.category, payload.emoji),
              ),
              Effect.tap(({ channel, settings }) => {
                const discordChannelName = applyDiscordFormat(
                  Option.match(settings, {
                    onNone: () => DEFAULT_CHANNEL_FORMAT,
                    onSome: (s) => s.discord_channel_format,
                  }),
                  channel.name,
                  payload.emoji,
                );
                return channelSync.emitManagedChannelCreated({
                  teamId,
                  teamChannelId: channel.id,
                  discordChannelName,
                });
              }),
              Effect.map(({ channel }) => toChannelDetail(channel, 0, [], payload.emoji)),
              Effect.catchTag('ChannelNameAlreadyTakenError', () =>
                Effect.fail(new ChannelApi.ChannelNameAlreadyTaken()),
              ),
            ),
          )
          .handle('getChannel', ({ params: { teamId, channelId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('channel', () =>
                channels.findById(channelId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new ChannelApi.ChannelNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ channel }) =>
                channel.team_id !== teamId
                  ? Effect.fail(new ChannelApi.ChannelNotFound())
                  : Effect.void,
              ),
              Effect.bind('grants', ({ channel }) => channelAccess.findByChannel(channel.id)),
              Effect.map(({ channel, grants }) =>
                toChannelDetail(channel, grants.length, grants, channel.emoji),
              ),
            ),
          )
          .handle('renameChannel', ({ params: { teamId, channelId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('existing', () =>
                channels.findById(channelId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new ChannelApi.ChannelNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ existing }) =>
                existing.team_id !== teamId
                  ? Effect.fail(new ChannelApi.ChannelNotFound())
                  : Effect.void,
              ),
              Effect.bind('updated', () => channels.rename(channelId, payload.name)),
              Effect.bind('grants', () => channelAccess.findByChannel(channelId)),
              // Rename updates the read model only. No Discord sync event is emitted in v1
              // because the bot handler for managed channel rename is out of scope.
              Effect.map(({ updated, grants }) =>
                toChannelDetail(updated, grants.length, grants, updated.emoji),
              ),
              Effect.catchTag('ChannelNameAlreadyTakenError', () =>
                Effect.fail(new ChannelApi.ChannelNameAlreadyTaken()),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => `Channel ${channelId} not found when renaming`),
              ),
            ),
          )
          .handle('archiveChannel', ({ params: { teamId, channelId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('channel', () =>
                channels.findById(channelId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new ChannelApi.ChannelNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ channel }) =>
                channel.team_id !== teamId
                  ? Effect.fail(new ChannelApi.ChannelNotFound())
                  : Effect.void,
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.tap(({ channel, settings }) => {
                const archiveCategoryId = Option.flatMap(
                  settings,
                  (s) => s.discord_archive_category_id,
                );
                return SqlClient.SqlClient.asEffect().pipe(
                  Effect.flatMap((sql) =>
                    sql
                      .withTransaction(
                        channels.setArchived(channelId, true).pipe(
                          Effect.flatMap(() =>
                            Option.isSome(archiveCategoryId)
                              ? channelSync.emitManagedChannelArchived({
                                  teamId,
                                  teamChannelId: channelId,
                                  discordChannelId: channel.discord_channel_id,
                                  archiveCategoryId: archiveCategoryId.value,
                                })
                              : Effect.void,
                          ),
                        ),
                      )
                      .pipe(catchSqlErrors),
                  ),
                );
              }),
              Effect.asVoid,
            ),
          )
          .handle('archiveDiscordChannel', ({ params: { teamId, discordChannelId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(forbidden),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.bind('archiveCategoryId', ({ settings }) =>
                Option.match(
                  Option.flatMap(settings, (s) => s.discord_archive_category_id),
                  {
                    onNone: () => Effect.fail(new ChannelApi.ArchiveCategoryNotConfigured()),
                    onSome: Effect.succeed,
                  },
                ),
              ),
              Effect.let('guildId', ({ team }) => team.guild_id),
              Effect.bind('discordChannel', ({ guildId }) =>
                discordChannels.findByChannelId(guildId, discordChannelId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new ChannelApi.ChannelNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ discordChannel, archiveCategoryId }) => {
                // Reject if it's a category (type=4)
                if (discordChannel.type === 4) {
                  return Effect.fail(new ChannelApi.ChannelNotArchivable());
                }
                // Reject if this channel IS the archive category
                if (discordChannel.channel_id === archiveCategoryId) {
                  return Effect.fail(new ChannelApi.ChannelNotArchivable());
                }
                // Reject if already archived (parent_id === archiveCategoryId)
                if (
                  Option.match(discordChannel.parent_id, {
                    onNone: () => false,
                    onSome: (pid) => pid === archiveCategoryId,
                  })
                ) {
                  return Effect.fail(new ChannelApi.ChannelNotArchivable());
                }
                return Effect.void;
              }),
              // Check if a managed team_channels row exists for this discord channel
              Effect.bind('managedChannels', () => channels.findAllByTeam(teamId)),
              Effect.let('existingManaged', ({ managedChannels }) =>
                Option.fromNullishOr(
                  managedChannels.find((ch) =>
                    Option.match(ch.discord_channel_id, {
                      onNone: () => false,
                      onSome: (id) => id === discordChannelId,
                    }),
                  ),
                ),
              ),
              Effect.flatMap(({ existingManaged, archiveCategoryId }) =>
                Option.match(existingManaged, {
                  onSome: (managed) => {
                    // Guard: if the managed channel is already archived, do not re-archive.
                    if (managed.archived === true) {
                      return Effect.fail(new ChannelApi.ChannelNotArchivable());
                    }
                    // Reuse managed archive: setArchived + emitManagedChannelArchived.
                    // We intentionally keep the discord_channel_id link so that the archived
                    // managed channel de-dups correctly in listChannels (the LEFT JOIN still
                    // matches → appears once as managed=true).
                    return SqlClient.SqlClient.asEffect().pipe(
                      Effect.flatMap((sql) =>
                        sql
                          .withTransaction(
                            channels.setArchived(managed.id, true).pipe(
                              Effect.flatMap(() =>
                                channelSync.emitManagedChannelArchived({
                                  teamId,
                                  teamChannelId: managed.id,
                                  discordChannelId: managed.discord_channel_id,
                                  archiveCategoryId,
                                }),
                              ),
                            ),
                          )
                          .pipe(catchSqlErrors),
                      ),
                    );
                  },
                  onNone: () =>
                    // Emit discord-only archive event
                    channelSync.emitDiscordChannelArchived({
                      teamId,
                      discordChannelId,
                      archiveCategoryId,
                    }),
                }),
              ),
              Effect.asVoid,
            ),
          )
          .handle('setAccess', ({ params: { teamId, channelId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('channel', () =>
                channels.findById(channelId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new ChannelApi.ChannelNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ channel }) =>
                channel.team_id !== teamId
                  ? Effect.fail(new ChannelApi.ChannelNotFound())
                  : Effect.void,
              ),
              Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
              Effect.flatMap(({ channel, sql }) =>
                sql
                  .withTransaction(
                    Effect.Do.pipe(
                      Effect.bind('current', () => channelAccess.findByChannelForUpdate(channelId)),
                      Effect.let(
                        'requested',
                        () =>
                          new Map(payload.grants.map((g) => [g.groupId, g.accessLevel] as const)),
                      ),
                      Effect.let(
                        'currentMap',
                        ({ current }) =>
                          new Map(current.map((g) => [g.group_id, g.access_level] as const)),
                      ),
                      // Compute grants to apply (added or level-changed)
                      Effect.let('toGrant', ({ requested, currentMap }) =>
                        Array.fromIterable(requested.entries()).filter(
                          ([gid, level]) => currentMap.get(gid) !== level,
                        ),
                      ),
                      // Compute grants to revoke (present in current but not in requested)
                      Effect.let('toRevoke', ({ requested, currentMap }) =>
                        Array.fromIterable(currentMap.keys()).filter((gid) => !requested.has(gid)),
                      ),
                      // Apply upserts
                      Effect.tap(({ toGrant }) =>
                        Effect.forEach(
                          toGrant,
                          ([groupId, level]) =>
                            channelAccess.upsertGrant(channelId, groupId, level),
                          { concurrency: 'unbounded' },
                        ),
                      ),
                      // Apply deletes
                      Effect.tap(({ toRevoke }) =>
                        Effect.forEach(
                          toRevoke,
                          (groupId) => channelAccess.deleteGrant(channelId, groupId),
                          { concurrency: 'unbounded' },
                        ),
                      ),
                      // Resolve role IDs for all affected groups
                      Effect.bind('allAffectedGroupIds', ({ toGrant, toRevoke }) =>
                        Effect.succeed([...toGrant.map(([gid]) => gid), ...toRevoke]),
                      ),
                      Effect.bind('roleMap', ({ allAffectedGroupIds }) =>
                        allAffectedGroupIds.length === 0
                          ? Effect.succeed(new Map<GroupModel.GroupId, Discord.Snowflake | null>())
                          : channelAccess
                              .findGroupRoleIds(allAffectedGroupIds)
                              .pipe(
                                Effect.map(
                                  (rows) =>
                                    new Map(
                                      rows.map((r) => [
                                        r.group_id,
                                        Option.getOrNull(r.discord_role_id),
                                      ]),
                                    ),
                                ),
                              ),
                      ),
                      // Emit access granted batch
                      Effect.tap(({ toGrant, roleMap }) => {
                        const discordChannelId = Option.getOrNull(channel.discord_channel_id);
                        if (discordChannelId === null) return Effect.void;
                        const { entries, unresolvableGroupIds } = buildManagedAccessGrantEntries(
                          toGrant.map(([groupId, accessLevel]) => ({ groupId, accessLevel })),
                          roleMap,
                          { teamChannelId: channelId, discordChannelId },
                        );
                        return Effect.forEach(unresolvableGroupIds, (gid) =>
                          Effect.logWarning(
                            `setAccess: skipping grant for group ${gid} on channel ${channelId} — no discord_role_id resolved`,
                          ),
                        ).pipe(
                          Effect.flatMap(() =>
                            channelSync.emitManagedAccessGrantedBatch({ teamId, entries }),
                          ),
                        );
                      }),
                      // Emit access revoked batch
                      Effect.tap(({ toRevoke, roleMap }) => {
                        const discordChannelId = Option.getOrNull(channel.discord_channel_id);
                        if (discordChannelId === null) return Effect.void;
                        const unresolvable = toRevoke.filter(
                          (gid) => (roleMap.get(gid) ?? null) === null,
                        );
                        const entries = toRevoke.flatMap((groupId) => {
                          const discordRoleId = roleMap.get(groupId);
                          if (discordRoleId == null) return [];
                          return [{ discordChannelId, discordRoleId }];
                        });
                        return Effect.forEach(unresolvable, (gid) =>
                          Effect.logWarning(
                            `setAccess: skipping revoke for group ${gid} on channel ${channelId} — no discord_role_id resolved`,
                          ),
                        ).pipe(
                          Effect.flatMap(() =>
                            channelSync.emitManagedAccessRevokedBatch({ teamId, entries }),
                          ),
                        );
                      }),
                      // Return updated channel detail
                      Effect.bind('updatedGrants', () => channelAccess.findByChannel(channelId)),
                      Effect.map(({ updatedGrants }) =>
                        toChannelDetail(
                          channel,
                          updatedGrants.length,
                          updatedGrants,
                          channel.emoji,
                        ),
                      ),
                    ),
                  )
                  .pipe(catchSqlErrors),
              ),
            ),
          )
          .handle('adoptDiscordChannel', ({ params: { teamId, discordChannelId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(forbidden),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.let('guildId', ({ team }) => team.guild_id),
              Effect.bind('discordChannel', ({ guildId }) =>
                discordChannels.findByChannelId(guildId, discordChannelId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new ChannelApi.ChannelNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ discordChannel }) => {
                if (discordChannel.type !== 0) {
                  return Effect.fail(new ChannelApi.ChannelNotAdoptable());
                }
                return Effect.void;
              }),
              // Idempotency: check if already adopted
              Effect.bind('existingChannels', () => channels.findAllByTeam(teamId)),
              Effect.let('alreadyAdopted', ({ existingChannels }) =>
                Option.fromNullishOr(
                  existingChannels.find((ch) =>
                    Option.match(ch.discord_channel_id, {
                      onNone: () => false,
                      onSome: (id) => id === discordChannelId,
                    }),
                  ),
                ),
              ),
              Effect.bind('categoryName', ({ discordChannel, guildId }) =>
                Option.match(discordChannel.parent_id, {
                  onNone: () => Effect.succeed(Option.none<string>()),
                  onSome: (parentId) =>
                    discordChannels
                      .findByChannelId(guildId, parentId)
                      .pipe(Effect.map(Option.map((cat) => cat.name))),
                }),
              ),
              Effect.bind('sqlClient', () => SqlClient.SqlClient.asEffect()),
              Effect.flatMap(({ alreadyAdopted, discordChannel, categoryName, sqlClient }) =>
                Option.match(alreadyAdopted, {
                  onSome: (existing) =>
                    // Idempotent pre-check path: already adopted — return its detail, no event
                    channelAccess
                      .findByChannel(existing.id)
                      .pipe(
                        Effect.map((grants) =>
                          toChannelDetail(existing, grants.length, grants, existing.emoji),
                        ),
                      ),
                  onNone: () =>
                    sqlClient
                      .withTransaction(
                        channels
                          .insertAdopted(
                            teamId,
                            discordChannel.name,
                            categoryName,
                            discordChannelId,
                          )
                          .pipe(
                            // Fresh insert succeeded: emit the adopted event, then return detail
                            Effect.flatMap((row) =>
                              channelSync
                                .emitManagedChannelAdopted({
                                  teamId,
                                  teamChannelId: row.id,
                                  discordChannelId,
                                })
                                .pipe(Effect.map(() => toChannelDetail(row, 0, [], row.emoji))),
                            ),
                            // Concurrent race: another request already inserted — re-fetch the
                            // existing row and return its detail WITHOUT emitting a duplicate event.
                            Effect.catchTag('DiscordChannelAlreadyAdoptedError', (_e) =>
                              channels.findAllByTeam(teamId).pipe(
                                Effect.flatMap((all) => {
                                  const found = all.find((ch) =>
                                    Option.match(ch.discord_channel_id, {
                                      onNone: () => false,
                                      onSome: (id) => id === discordChannelId,
                                    }),
                                  );
                                  if (found === undefined) {
                                    return Effect.fail(new ChannelApi.ChannelNotFound());
                                  }
                                  return channelAccess
                                    .findByChannel(found.id)
                                    .pipe(
                                      Effect.map((grants) =>
                                        toChannelDetail(found, grants.length, grants, found.emoji),
                                      ),
                                    );
                                }),
                              ),
                            ),
                          ),
                      )
                      .pipe(
                        catchSqlErrors,
                        Effect.catchTag('ChannelNameAlreadyTakenError', () =>
                          Effect.fail(new ChannelApi.ChannelAdoptionNameConflict()),
                        ),
                      ),
                }),
              ),
            ),
          )
          .handle('bulkArchiveDiscordChannels', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(forbidden),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.bind('archiveCategoryId', ({ settings }) =>
                Option.match(
                  Option.flatMap(settings, (s) => s.discord_archive_category_id),
                  {
                    onNone: () => Effect.fail(new ChannelApi.ArchiveCategoryNotConfigured()),
                    onSome: Effect.succeed,
                  },
                ),
              ),
              Effect.let('guildId', ({ team }) => team.guild_id),
              Effect.bind('managedChannels', () => channels.findAllByTeam(teamId)),
              Effect.let('managedByDiscordId', ({ managedChannels }) => {
                const m = new Map<Discord.Snowflake, (typeof managedChannels)[number]>();
                for (const ch of managedChannels) {
                  Option.match(ch.discord_channel_id, {
                    onNone: () => undefined,
                    onSome: (id) => m.set(id, ch),
                  });
                }
                return m;
              }),
              Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
              Effect.flatMap(({ archiveCategoryId, guildId, managedByDiscordId, sql }) => {
                const archived: Discord.Snowflake[] = [];
                const skipped: {
                  discordChannelId: Discord.Snowflake;
                  reason: 'already_archived' | 'is_category' | 'is_archive_category' | 'not_found';
                }[] = [];
                const failed: { discordChannelId: Discord.Snowflake }[] = [];

                // Dedupe ids so a duplicated entry cannot double-emit or double-count
                const uniqueIds = Array.dedupe(payload.discordChannelIds);

                return Effect.forEach(
                  uniqueIds,
                  (id) =>
                    Effect.Do.pipe(
                      Effect.bind('discordChannel', () =>
                        discordChannels.findByChannelId(guildId, id),
                      ),
                      Effect.flatMap(({ discordChannel }) => {
                        if (Option.isNone(discordChannel)) {
                          skipped.push({ discordChannelId: id, reason: 'not_found' });
                          return Effect.void;
                        }
                        const ch = discordChannel.value;
                        if (ch.type === 4) {
                          skipped.push({ discordChannelId: id, reason: 'is_category' });
                          return Effect.void;
                        }
                        if (ch.channel_id === archiveCategoryId) {
                          skipped.push({ discordChannelId: id, reason: 'is_archive_category' });
                          return Effect.void;
                        }
                        const alreadyInArchive = Option.match(ch.parent_id, {
                          onNone: () => false,
                          onSome: (pid) => pid === archiveCategoryId,
                        });
                        const managedRow = managedByDiscordId.get(id);
                        const managedAlreadyArchived = managedRow?.archived === true;
                        if (alreadyInArchive || managedAlreadyArchived) {
                          skipped.push({ discordChannelId: id, reason: 'already_archived' });
                          return Effect.void;
                        }
                        // Archive it
                        const archiveEffect =
                          managedRow !== undefined
                            ? sql
                                .withTransaction(
                                  channels.setArchived(managedRow.id, true).pipe(
                                    Effect.flatMap(() =>
                                      channelSync.emitManagedChannelArchived({
                                        teamId,
                                        teamChannelId: managedRow.id,
                                        discordChannelId: managedRow.discord_channel_id,
                                        archiveCategoryId,
                                      }),
                                    ),
                                  ),
                                )
                                .pipe(catchSqlErrors)
                            : channelSync.emitDiscordChannelArchived({
                                teamId,
                                discordChannelId: id,
                                archiveCategoryId,
                              });
                        return archiveEffect.pipe(
                          Effect.tap(() => {
                            archived.push(id);
                            return Effect.void;
                          }),
                        );
                      }),
                    ).pipe(
                      Effect.exit,
                      Effect.flatMap((exit) => {
                        if (Exit.isFailure(exit)) {
                          failed.push({ discordChannelId: id });
                        }
                        return Effect.void;
                      }),
                    ),
                  { concurrency: 1 },
                ).pipe(
                  Effect.map(
                    () => new ChannelApi.ChannelBulkArchiveResult({ archived, skipped, failed }),
                  ),
                );
              }),
            ),
          )
          .handle('restoreDiscordChannel', ({ params: { teamId, discordChannelId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(forbidden),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.let('guildId', ({ team }) => team.guild_id),
              Effect.bind('discordChannel', ({ guildId }) =>
                discordChannels.findByChannelId(guildId, discordChannelId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new ChannelApi.ChannelNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(({ discordChannel }) => {
                if (discordChannel.type === 4) {
                  return Effect.fail(new ChannelApi.ChannelNotRestorable());
                }
                return Effect.void;
              }),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.let('archiveCategoryId', ({ settings }) =>
                Option.flatMap(settings, (s) => s.discord_archive_category_id),
              ),
              Effect.bind('managedChannels', () => channels.findAllByTeam(teamId)),
              Effect.let('existingManaged', ({ managedChannels }) =>
                Option.fromNullishOr(
                  managedChannels.find((ch) =>
                    Option.match(ch.discord_channel_id, {
                      onNone: () => false,
                      onSome: (id) => id === discordChannelId,
                    }),
                  ),
                ),
              ),
              Effect.flatMap(({ existingManaged, discordChannel, archiveCategoryId }) =>
                Option.match(existingManaged, {
                  onSome: (managed) => {
                    if (managed.archived === false) {
                      // Already active — not restorable
                      return Effect.fail(new ChannelApi.ChannelNotRestorable());
                    }
                    // Restore the managed archived channel
                    return SqlClient.SqlClient.asEffect().pipe(
                      Effect.flatMap((sql) =>
                        sql
                          .withTransaction(
                            channels.setArchived(managed.id, false).pipe(
                              Effect.flatMap(() =>
                                channelSync.emitManagedChannelRestored({
                                  teamId,
                                  teamChannelId: managed.id,
                                  discordChannelId,
                                }),
                              ),
                            ),
                          )
                          .pipe(catchSqlErrors),
                      ),
                    );
                  },
                  onNone: () => {
                    // Discord-only channel: only restorable if in archive category
                    const inArchive = Option.match(archiveCategoryId, {
                      onNone: () => false,
                      onSome: (catId) =>
                        Option.match(discordChannel.parent_id, {
                          onNone: () => false,
                          onSome: (pid) => pid === catId,
                        }),
                    });
                    if (!inArchive) {
                      return Effect.fail(new ChannelApi.ChannelNotRestorable());
                    }
                    return channelSync.emitDiscordChannelRestored({ teamId, discordChannelId });
                  },
                }),
              ),
              Effect.asVoid,
            ),
          )
          .handle('bulkRestoreDiscordChannels', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'group:manage', forbidden),
              ),
              Effect.bind('team', () =>
                teams.findById(teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(forbidden),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.let('guildId', ({ team }) => team.guild_id),
              Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
              Effect.let('archiveCategoryId', ({ settings }) =>
                Option.flatMap(settings, (s) => s.discord_archive_category_id),
              ),
              Effect.bind('managedChannels', () => channels.findAllByTeam(teamId)),
              Effect.let('managedByDiscordId', ({ managedChannels }) => {
                const m = new Map<Discord.Snowflake, (typeof managedChannels)[number]>();
                for (const ch of managedChannels) {
                  Option.match(ch.discord_channel_id, {
                    onNone: () => undefined,
                    onSome: (id) => m.set(id, ch),
                  });
                }
                return m;
              }),
              Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
              Effect.flatMap(({ archiveCategoryId, guildId, managedByDiscordId, sql }) => {
                const restored: Discord.Snowflake[] = [];
                const skipped: {
                  discordChannelId: Discord.Snowflake;
                  reason: 'already_active' | 'is_category' | 'not_found' | 'not_archived';
                }[] = [];
                const failed: { discordChannelId: Discord.Snowflake }[] = [];

                // Dedupe ids so a duplicated entry cannot double-emit or double-count
                const uniqueIds = Array.dedupe(payload.discordChannelIds);

                return Effect.forEach(
                  uniqueIds,
                  (id) =>
                    Effect.Do.pipe(
                      Effect.bind('discordChannel', () =>
                        discordChannels.findByChannelId(guildId, id),
                      ),
                      Effect.flatMap(({ discordChannel }) => {
                        if (Option.isNone(discordChannel)) {
                          skipped.push({ discordChannelId: id, reason: 'not_found' });
                          return Effect.void;
                        }
                        const ch = discordChannel.value;
                        if (ch.type === 4) {
                          skipped.push({ discordChannelId: id, reason: 'is_category' });
                          return Effect.void;
                        }
                        const managedRow = managedByDiscordId.get(id);
                        if (managedRow !== undefined) {
                          if (managedRow.archived === false) {
                            skipped.push({ discordChannelId: id, reason: 'already_active' });
                            return Effect.void;
                          }
                          // Restore managed archived channel
                          const restoreEffect = sql
                            .withTransaction(
                              channels.setArchived(managedRow.id, false).pipe(
                                Effect.flatMap(() =>
                                  channelSync.emitManagedChannelRestored({
                                    teamId,
                                    teamChannelId: managedRow.id,
                                    discordChannelId: id,
                                  }),
                                ),
                              ),
                            )
                            .pipe(catchSqlErrors);
                          return restoreEffect.pipe(
                            Effect.tap(() => {
                              restored.push(id);
                              return Effect.void;
                            }),
                          );
                        }
                        // Discord-only channel: only restorable if in archive category
                        const inArchive = Option.match(archiveCategoryId, {
                          onNone: () => false,
                          onSome: (catId) =>
                            Option.match(ch.parent_id, {
                              onNone: () => false,
                              onSome: (pid) => pid === catId,
                            }),
                        });
                        if (!inArchive) {
                          skipped.push({ discordChannelId: id, reason: 'not_archived' });
                          return Effect.void;
                        }
                        const restoreEffect = channelSync.emitDiscordChannelRestored({
                          teamId,
                          discordChannelId: id,
                        });
                        return restoreEffect.pipe(
                          Effect.tap(() => {
                            restored.push(id);
                            return Effect.void;
                          }),
                        );
                      }),
                    ).pipe(
                      Effect.exit,
                      Effect.flatMap((exit) => {
                        if (Exit.isFailure(exit)) {
                          failed.push({ discordChannelId: id });
                        }
                        return Effect.void;
                      }),
                    ),
                  { concurrency: 1 },
                ).pipe(
                  Effect.map(
                    () => new ChannelApi.ChannelBulkRestoreResult({ restored, skipped, failed }),
                  ),
                );
              }),
            ),
          ),
    ),
  ),
);
