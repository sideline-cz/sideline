/**
 * Managed-channel writes shared by the HTTP handlers (`api/channel.ts`) and the AI write path
 * (`services/ai/actions.ts`, the three Discord actions). Same reason as `EventCreation.ts` for
 * living here and not in `api/channel.ts`: that would drag `api/api.ts` into the AI tool graph.
 *
 * No function here calls `sql.withTransaction` — the caller owns the transaction. Each one only
 * writes Sideline rows and QUEUES `channel_sync_events` rows; the bot applies them later.
 */
import type { Discord, GroupModel, Team, TeamChannel, TeamChannelAccess } from '@sideline/domain';
import { Array, Effect, Option } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { applyDiscordFormat, DEFAULT_CHANNEL_FORMAT } from '~/utils/applyDiscordFormat.js';
import { emitMissingGroupRoleProvision } from '~/utils/emitGroupRoleBackfill.js';
import { buildManagedAccessGrantEntries } from '~/utils/managedAccessEntries.js';

interface ManagedChannelRef {
  readonly id: TeamChannel.TeamChannelId;
  readonly discord_channel_id: Option.Option<Discord.Snowflake>;
}

/** Inserts the `team_channels` row and queues `channel_created`. Fails
 *  `ChannelNameAlreadyTakenError` when an active channel already has the name. */
export const createManagedChannel = ({
  teamId,
  name,
  category,
  emoji,
}: {
  readonly teamId: Team.TeamId;
  readonly name: string;
  readonly category: Option.Option<string>;
  readonly emoji: Option.Option<string>;
}) =>
  Effect.Do.pipe(
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('channels', () => TeamChannelsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('settings', ({ teamSettings }) => teamSettings.findByTeamId(teamId)),
    Effect.bind('channel', ({ channels }) => channels.insert(teamId, name, category, emoji)),
    Effect.tap(({ channel, settings, channelSync }) =>
      channelSync.emitManagedChannelCreated({
        teamId,
        teamChannelId: channel.id,
        discordChannelName: applyDiscordFormat(
          Option.match(settings, {
            onNone: () => DEFAULT_CHANNEL_FORMAT,
            onSome: (s) => s.discord_channel_format,
          }),
          channel.name,
          emoji,
        ),
      }),
    ),
    Effect.map(({ channel }) => channel),
  );

/** Marks the channel archived and, when the team has an archive category, queues
 *  `channel_archived`. With no category nothing is queued (same as the HTTP path always did). */
export const archiveManagedChannelTx = ({
  teamId,
  channel,
  archiveCategoryId,
}: {
  readonly teamId: Team.TeamId;
  readonly channel: ManagedChannelRef;
  readonly archiveCategoryId: Option.Option<Discord.Snowflake>;
}) =>
  Effect.Do.pipe(
    Effect.bind('channels', () => TeamChannelsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.flatMap(({ channels, channelSync }) =>
      channels.setArchived(channel.id, true).pipe(
        Effect.flatMap(() =>
          Option.isSome(archiveCategoryId)
            ? channelSync.emitManagedChannelArchived({
                teamId,
                teamChannelId: channel.id,
                discordChannelId: channel.discord_channel_id,
                archiveCategoryId: archiveCategoryId.value,
              })
            : Effect.void,
        ),
      ),
    ),
  );

/**
 * Replaces the channel's grants with `toRequested(current)` and queues the grant / revoke events.
 * `current` is read `FOR UPDATE`, so a caller that changes one group (the AI path) merges into the
 * latest state instead of overwriting it.
 */
export const setManagedChannelAccessTx = ({
  teamId,
  channel,
  toRequested,
}: {
  readonly teamId: Team.TeamId;
  readonly channel: ManagedChannelRef;
  readonly toRequested: (
    current: ReadonlyArray<{
      readonly group_id: GroupModel.GroupId;
      readonly access_level: TeamChannelAccess.AccessLevel;
    }>,
  ) => ReadonlyMap<GroupModel.GroupId, TeamChannelAccess.AccessLevel>;
}) => {
  const channelId = channel.id;
  return Effect.Do.pipe(
    Effect.bind('channelAccess', () => TeamChannelAccessRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('current', ({ channelAccess }) => channelAccess.findByChannelForUpdate(channelId)),
    Effect.let('requested', ({ current }) => toRequested(current)),
    Effect.let(
      'currentMap',
      ({ current }) => new Map(current.map((g) => [g.group_id, g.access_level] as const)),
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
    Effect.tap(({ toGrant, channelAccess }) =>
      Effect.forEach(
        toGrant,
        ([groupId, level]) => channelAccess.upsertGrant(channelId, groupId, level),
        { concurrency: 'unbounded' },
      ),
    ),
    // Apply deletes
    Effect.tap(({ toRevoke, channelAccess }) =>
      Effect.forEach(toRevoke, (groupId) => channelAccess.deleteGrant(channelId, groupId), {
        concurrency: 'unbounded',
      }),
    ),
    // Resolve role IDs for all affected groups
    Effect.bind('allAffectedGroupIds', ({ toGrant, toRevoke }) =>
      Effect.succeed([...toGrant.map(([gid]) => gid), ...toRevoke]),
    ),
    Effect.bind('roleMap', ({ allAffectedGroupIds, channelAccess }) =>
      allAffectedGroupIds.length === 0
        ? Effect.succeed(new Map<GroupModel.GroupId, Discord.Snowflake | null>())
        : channelAccess
            .findGroupRoleIds(allAffectedGroupIds)
            .pipe(
              Effect.map(
                (rows) =>
                  new Map(rows.map((r) => [r.group_id, Option.getOrNull(r.discord_role_id)])),
              ),
            ),
    ),
    // Emit access granted batch
    Effect.tap(({ toGrant, roleMap, channelSync }) => {
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
        Effect.flatMap(() => channelSync.emitManagedAccessGrantedBatch({ teamId, entries })),
        Effect.flatMap(() => {
          if (unresolvableGroupIds.length === 0) return Effect.void;
          // Best-effort: enqueue provisioning for role-less groups so they
          // self-heal once the role lands. Guarded by hasUnprocessedForGroups
          // to avoid duplicate events on repeated setAccess calls.
          // Must NOT fail the request.
          return DiscordChannelMappingRepository.asEffect().pipe(
            Effect.flatMap((mappingsRepo) =>
              channelSync.hasUnprocessedForGroups([...unresolvableGroupIds]).pipe(
                Effect.flatMap((inFlightIds) => {
                  const inFlightSet = new Set(inFlightIds);
                  const toProvision = unresolvableGroupIds.filter((gid) => !inFlightSet.has(gid));
                  if (toProvision.length === 0) return Effect.void;
                  return mappingsRepo
                    .findGroupsMissingRole(Option.some(teamId), toProvision.length * 2)
                    .pipe(
                      Effect.flatMap((candidateGroups) => {
                        const provisionSet = new Set(toProvision);
                        const toEmit = candidateGroups.filter((g) => provisionSet.has(g.group_id));
                        return Effect.forEach(toEmit, emitMissingGroupRoleProvision, {
                          concurrency: 1,
                        }).pipe(Effect.asVoid);
                      }),
                    );
                }),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(`setAccess: best-effort backfill failed (non-fatal): ${cause}`),
            ),
          );
        }),
      );
    }),
    // Emit access revoked batch
    Effect.tap(({ toRevoke, roleMap, channelSync }) => {
      const discordChannelId = Option.getOrNull(channel.discord_channel_id);
      if (discordChannelId === null) return Effect.void;
      const unresolvable = toRevoke.filter((gid) => (roleMap.get(gid) ?? null) === null);
      const entries = toRevoke.flatMap((groupId) => {
        const discordRoleId = roleMap.get(groupId);
        if (discordRoleId == null) return [];
        return [{ discordChannelId, discordRoleId }];
      });
      return Effect.forEach(unresolvable, (gid) =>
        Effect.logWarning(
          `setAccess: skipping revoke for group ${gid} on channel ${channelId} — no discord_role_id resolved`,
        ),
      ).pipe(Effect.flatMap(() => channelSync.emitManagedAccessRevokedBatch({ teamId, entries })));
    }),
    Effect.asVoid,
  );
};
