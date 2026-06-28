import {
  ChannelRpcGroup,
  ChannelRpcModels,
  type ChannelSyncEvent,
  type Discord,
  type DiscordChannelMapping,
  type GroupModel,
  type RosterModel,
  type Team,
  type TeamChannel,
} from '@sideline/domain';
import { Bind, LogicError } from '@sideline/effect-lib';
import { Array, Cause, Data, Effect, flow, Option, Result } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { emitMissingGroupRoleProvision } from '~/utils/emitGroupRoleBackfill.js';
import { buildManagedAccessGrantEntries } from '~/utils/managedAccessEntries.js';
import { constructEvent, EventPropertyMissing } from './events.js';

class NoChanges extends Data.TaggedError('NoChanges')<{
  count: 0;
}> {
  static make = () => new NoChanges({ count: 0 });
}

const toChannelMapping = (m: {
  readonly id: DiscordChannelMapping.DiscordChannelMappingId;
  readonly team_id: Team.TeamId;
  readonly entity_type: ChannelSyncEvent.ChannelSyncEntityType;
  readonly group_id: Option.Option<GroupModel.GroupId>;
  readonly roster_id: Option.Option<RosterModel.RosterId>;
  readonly discord_channel_id: Option.Option<Discord.Snowflake>;
  readonly discord_role_id: Option.Option<Discord.Snowflake>;
}) =>
  new ChannelRpcModels.ChannelMapping({
    id: m.id,
    team_id: m.team_id,
    entity_type: m.entity_type,
    group_id: m.group_id,
    roster_id: m.roster_id,
    discord_channel_id: m.discord_channel_id,
    discord_role_id: m.discord_role_id,
  });

const toManagedChannelMapping = (m: {
  readonly id: TeamChannel.TeamChannelId;
  readonly team_id: Team.TeamId;
  readonly discord_channel_id: Option.Option<Discord.Snowflake>;
}) =>
  new ChannelRpcModels.ManagedChannelMapping({
    team_channel_id: m.id,
    team_id: m.team_id,
    discord_channel_id: m.discord_channel_id,
  });

/**
 * After a group's discord_role_id transitions from None to Some, re-emit managed access grants
 * for all team_channel_access rows that reference this group but belong to channels that are
 * already provisioned (have a discord_channel_id).
 */
const reapplyGroupGrants = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  Effect.Do.pipe(
    Effect.bind('accessRepo', () => TeamChannelAccessRepository.asEffect()),
    Effect.bind('channelsRepo', () => TeamChannelsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('grants', ({ accessRepo }) => accessRepo.findGrantsByGroup(groupId)),
    Effect.tap(({ grants }) =>
      grants.length === 0
        ? Effect.logInfo(`reapplyGroupGrants: no grants for group ${groupId}, nothing to reapply`)
        : Effect.void,
    ),
    Effect.flatMap(({ grants, accessRepo, channelsRepo, channelSync }) => {
      if (grants.length === 0) return Effect.void;
      return Effect.Do.pipe(
        Effect.bind('roleRows', () => accessRepo.findGroupRoleIds([groupId])),
        Effect.flatMap(({ roleRows }) => {
          const roleRow = roleRows.find((r) => r.group_id === groupId);
          const discordRoleId =
            roleRow !== undefined ? Option.getOrNull(roleRow.discord_role_id) : null;
          if (discordRoleId === null) {
            return Effect.logWarning(
              `reapplyGroupGrants: no discord_role_id resolved for group ${groupId}, skipping`,
            );
          }
          const roleMap = new Map<GroupModel.GroupId, Discord.Snowflake | null>([
            [groupId, discordRoleId],
          ]);
          return Effect.forEach(
            grants,
            (grant) =>
              channelsRepo.findById(grant.team_channel_id).pipe(
                Effect.flatMap((maybeChannel) => {
                  if (Option.isNone(maybeChannel)) {
                    return Effect.logWarning(
                      `reapplyGroupGrants: team_channel ${grant.team_channel_id} not found, skipping grant for group ${groupId}`,
                    );
                  }
                  const channel = maybeChannel.value;
                  const discordChannelId = Option.getOrNull(channel.discord_channel_id);
                  if (discordChannelId === null) {
                    return Effect.logWarning(
                      `reapplyGroupGrants: team_channel ${grant.team_channel_id} has no discord_channel_id yet, skipping grant for group ${groupId}`,
                    );
                  }
                  const { entries } = buildManagedAccessGrantEntries(
                    [{ groupId: grant.group_id, accessLevel: grant.access_level }],
                    roleMap,
                    { teamChannelId: grant.team_channel_id, discordChannelId },
                  );
                  if (entries.length === 0) return Effect.void;
                  return channelSync.emitManagedAccessGrantedBatch({ teamId, entries });
                }),
              ),
            { concurrency: 'unbounded' },
          ).pipe(Effect.asVoid);
        }),
      );
    }),
    Effect.asVoid,
  );

export const ChannelsRpcLive = Effect.Do.pipe(
  Effect.bind('syncEvents', () => ChannelSyncEventsRepository.asEffect()),
  Effect.bind('mappings', () => DiscordChannelMappingRepository.asEffect()),
  Effect.bind('rosters', () => RostersRepository.asEffect()),
  Effect.let(
    'Channel/GetUnprocessedEvents',
    ({ syncEvents }) =>
      ({ limit }: { readonly limit: number }) =>
        syncEvents.findUnprocessed(limit).pipe(
          Effect.map(
            Array.map(
              flow(
                constructEvent,
                Effect.tapErrorTag('EventPropertyMissing', EventPropertyMissing.handle),
                Effect.result,
              ),
            ),
          ),
          Effect.tap((arr) =>
            Array.isArrayEmpty(arr) ? Effect.fail(NoChanges.make()) : Effect.void,
          ),
          Effect.tap((events) =>
            Effect.logInfo(`Collected ${events.length} channel events from database.`),
          ),
          Effect.flatMap(Effect.all),
          Effect.tap(flow(Array.filterMap(Result.flip), Array.map(Effect.logError), Effect.all)),
          Effect.map(Array.filterMap((r) => r)),
          Effect.tap((events) =>
            Effect.logInfo(`Successfully mapped ${events.length} channel events from database.`),
          ),
          Effect.catchTag('NoChanges', () => Effect.succeed(Array.empty())),
        ),
  ),
  Effect.let(
    'Channel/MarkEventProcessed',
    ({ syncEvents }) =>
      ({ id }: { readonly id: ChannelSyncEvent.ChannelSyncEventId }) =>
        syncEvents.markProcessed(id),
  ),
  Effect.let(
    'Channel/MarkEventFailed',
    ({ syncEvents }) =>
      ({
        id,
        error,
      }: {
        readonly id: ChannelSyncEvent.ChannelSyncEventId;
        readonly error: string;
      }) =>
        syncEvents.markFailed(id, error),
  ),
  Effect.let(
    'Channel/MarkEventPermanentlyFailed',
    ({ syncEvents }) =>
      ({
        id,
        error,
      }: {
        readonly id: ChannelSyncEvent.ChannelSyncEventId;
        readonly error: string;
      }) =>
        syncEvents.markPermanentlyFailed(id, error),
  ),
  // Group mapping RPCs
  Effect.let(
    'Channel/GetMapping',
    ({ mappings }) =>
      ({
        team_id,
        group_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly group_id: GroupModel.GroupId;
      }) =>
        mappings.findByGroupId(team_id, group_id).pipe(Effect.map(Option.map(toChannelMapping))),
  ),
  Effect.let(
    'Channel/UpsertMapping',
    ({ mappings }) =>
      ({
        team_id,
        group_id,
        discord_channel_id,
        discord_role_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly group_id: GroupModel.GroupId;
        readonly discord_channel_id: Discord.Snowflake;
        readonly discord_role_id: Discord.Snowflake;
      }) =>
        mappings.insert(team_id, group_id, discord_channel_id, discord_role_id).pipe(
          Effect.tap((old_role_id) =>
            Option.isNone(old_role_id)
              ? reapplyGroupGrants(team_id, group_id).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning('reapplyGroupGrants failed (non-fatal)', cause),
                  ),
                )
              : Effect.void,
          ),
          Effect.asVoid,
        ),
  ),
  Effect.let(
    'Channel/UpsertMappingRoleOnly',
    ({ mappings }) =>
      ({
        team_id,
        group_id,
        discord_role_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly group_id: GroupModel.GroupId;
        readonly discord_role_id: Discord.Snowflake;
      }) =>
        mappings.insertRoleOnly(team_id, group_id, discord_role_id).pipe(
          Effect.tap((old_role_id) =>
            Option.isNone(old_role_id)
              ? reapplyGroupGrants(team_id, group_id).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning('reapplyGroupGrants failed (non-fatal)', cause),
                  ),
                )
              : Effect.void,
          ),
          Effect.asVoid,
        ),
  ),
  Effect.let(
    'Channel/UpsertGroupChannel',
    ({ mappings }) =>
      ({
        team_id,
        group_id,
        discord_channel_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly group_id: GroupModel.GroupId;
        readonly discord_channel_id: Discord.Snowflake;
      }) =>
        mappings.upsertGroupChannel(team_id, group_id, discord_channel_id),
  ),
  Effect.let(
    'Channel/DeleteMapping',
    ({ mappings }) =>
      ({
        team_id,
        group_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly group_id: GroupModel.GroupId;
      }) =>
        mappings.deleteByGroupId(team_id, group_id),
  ),
).pipe(
  // Roster mapping RPCs
  Effect.let(
    'Channel/GetRosterMapping',
    ({ mappings }) =>
      ({
        team_id,
        roster_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly roster_id: RosterModel.RosterId;
      }) =>
        mappings.findByRosterId(team_id, roster_id).pipe(Effect.map(Option.map(toChannelMapping))),
  ),
  Effect.let(
    'Channel/GetRosterMembers',
    () =>
      ({
        team_id,
        roster_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly roster_id: RosterModel.RosterId;
      }) =>
        RostersRepository.asEffect().pipe(
          Effect.flatMap((rosters) =>
            rosters.findRosterById(roster_id).pipe(
              Effect.flatMap(
                // Scope to the requesting team: a roster from another team yields no members.
                Option.match({
                  onNone: () => Effect.succeed(Array.empty<ChannelRpcModels.RosterMemberDiscord>()),
                  onSome: (roster) =>
                    roster.team_id !== team_id
                      ? Effect.succeed(Array.empty<ChannelRpcModels.RosterMemberDiscord>())
                      : rosters.findMemberEntriesById(roster_id).pipe(
                          Effect.map(
                            Array.map(
                              (entry) =>
                                new ChannelRpcModels.RosterMemberDiscord({
                                  team_member_id: entry.member_id,
                                  discord_user_id: entry.discord_id,
                                }),
                            ),
                          ),
                        ),
                }),
              ),
            ),
          ),
        ),
  ),
  Effect.let(
    'Channel/GetGroupMembers',
    () =>
      ({
        team_id,
        group_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly group_id: GroupModel.GroupId;
      }) =>
        GroupsRepository.asEffect().pipe(
          Effect.flatMap((groups) =>
            groups.findGroupById(group_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Array.empty<ChannelRpcModels.GroupMemberDiscord>()),
                  onSome: (group) =>
                    group.team_id !== team_id
                      ? Effect.succeed(Array.empty<ChannelRpcModels.GroupMemberDiscord>())
                      : groups.findDescendantMembersWithDiscordIdByGroupId(group_id).pipe(
                          Effect.map((rows) =>
                            Array.filterMap(rows, (row) =>
                              row.discordUserId === null
                                ? Result.failVoid
                                : Result.succeed(
                                    new ChannelRpcModels.GroupMemberDiscord({
                                      team_member_id: row.teamMemberId,
                                      discord_user_id: row.discordUserId,
                                    }),
                                  ),
                            ),
                          ),
                        ),
                }),
              ),
            ),
          ),
        ),
  ),
  Effect.let(
    'Channel/UpsertRosterMapping',
    ({ mappings }) =>
      ({
        team_id,
        roster_id,
        discord_channel_id,
        discord_role_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly roster_id: RosterModel.RosterId;
        readonly discord_channel_id: Discord.Snowflake;
        readonly discord_role_id: Discord.Snowflake;
      }) =>
        mappings.insertRoster(team_id, roster_id, discord_channel_id, discord_role_id),
  ),
  Effect.let(
    'Channel/DeleteRosterMapping',
    ({ mappings }) =>
      ({
        team_id,
        roster_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly roster_id: RosterModel.RosterId;
      }) =>
        mappings.deleteByRosterId(team_id, roster_id),
  ),
  // Roster channel update
  Effect.let(
    'Channel/UpdateRosterChannel',
    ({ rosters }) =>
      ({
        roster_id,
        discord_channel_id,
      }: {
        readonly roster_id: RosterModel.RosterId;
        readonly discord_channel_id: Option.Option<Discord.Snowflake>;
      }) =>
        rosters.findRosterById(roster_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Cause.NoSuchElementError()),
              onSome: (existing) =>
                rosters.update({
                  id: roster_id,
                  name: Option.none(),
                  active: Option.none(),
                  color: existing.color,
                  emoji: existing.emoji,
                  discord_channel_id: Option.some(discord_channel_id),
                }),
            }),
          ),
          Effect.catchTag(
            'NoSuchElementError',
            LogicError.withMessage(() => `Roster ${roster_id} not found when updating channel`),
          ),
          Effect.asVoid,
        ),
  ),
  // Managed channel mappings — acquire TeamChannelsRepository lazily inside each handler
  // to avoid TypeScript pipe-depth inference issues with too many accumulated bound fields.
  Effect.let(
    'Channel/GetManagedChannel',
    () =>
      ({ team_channel_id }: { readonly team_channel_id: TeamChannel.TeamChannelId }) =>
        TeamChannelsRepository.asEffect().pipe(
          Effect.flatMap((repo) =>
            repo.findById(team_channel_id).pipe(Effect.map(Option.map(toManagedChannelMapping))),
          ),
        ),
  ),
  Effect.let(
    'Channel/UpsertManagedChannel',
    () =>
      ({
        team_channel_id,
        discord_channel_id,
      }: {
        readonly team_channel_id: TeamChannel.TeamChannelId;
        readonly discord_channel_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('channelsRepo', () => TeamChannelsRepository.asEffect()),
          Effect.bind('accessRepo', () => TeamChannelAccessRepository.asEffect()),
          Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
          // 1. Persist the discord_channel_id
          Effect.tap(({ channelsRepo }) =>
            channelsRepo.upsertDiscordChannelId(team_channel_id, discord_channel_id),
          ),
          // 2. Reconcile any grants that were created before the channel was provisioned
          Effect.bind('channel', ({ channelsRepo }) =>
            channelsRepo.findById(team_channel_id).pipe(
              Effect.map(
                Option.match({
                  onNone: () => Option.none<{ team_id: Team.TeamId }>(),
                  onSome: (ch) => Option.some({ team_id: ch.team_id }),
                }),
              ),
            ),
          ),
          Effect.tap(({ channel, accessRepo, channelSync }) =>
            Option.match(channel, {
              onNone: () => Effect.void,
              onSome: ({ team_id }) =>
                Effect.Do.pipe(
                  Effect.bind('grants', () => accessRepo.findByChannel(team_channel_id)),
                  Effect.bind('roleMap', ({ grants }) =>
                    grants.length === 0
                      ? Effect.succeed(new Map<GroupModel.GroupId, Discord.Snowflake | null>())
                      : accessRepo
                          .findGroupRoleIds(grants.map((g) => g.group_id))
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
                  Effect.tap(({ grants, roleMap }) => {
                    const { entries, unresolvableGroupIds } = buildManagedAccessGrantEntries(
                      grants.map((g) => ({ groupId: g.group_id, accessLevel: g.access_level })),
                      roleMap,
                      {
                        teamChannelId: team_channel_id,
                        discordChannelId: discord_channel_id,
                      },
                    );
                    return Effect.forEach(unresolvableGroupIds, (groupId) =>
                      Effect.logWarning(
                        `UpsertManagedChannel reconcile: skipping grant for group ${groupId} on channel ${team_channel_id} — no discord_role_id resolved`,
                      ),
                    ).pipe(
                      Effect.flatMap(() => {
                        if (entries.length === 0) return Effect.void;
                        return channelSync.emitManagedAccessGrantedBatch({
                          teamId: team_id,
                          entries,
                        });
                      }),
                    );
                  }),
                  Effect.asVoid,
                ),
            }),
          ),
          Effect.asVoid,
        ),
  ),
  Effect.let(
    'Channel/ClearManagedChannel',
    () =>
      ({ team_channel_id }: { readonly team_channel_id: TeamChannel.TeamChannelId }) =>
        TeamChannelsRepository.asEffect().pipe(
          Effect.flatMap((repo) => repo.clearDiscordChannelId(team_channel_id)),
        ),
  ),
  Effect.let(
    'Channel/DeleteManagedChannel',
    () =>
      ({ team_channel_id }: { readonly team_channel_id: TeamChannel.TeamChannelId }) =>
        TeamChannelsRepository.asEffect().pipe(
          Effect.flatMap((repo) => repo.delete(team_channel_id)),
        ),
  ),
  Effect.let(
    'Channel/BackfillMissingGroupRoles',
    () =>
      ({
        team_id,
        limit,
      }: {
        readonly team_id: Option.Option<Team.TeamId>;
        readonly limit: Option.Option<number>;
      }) =>
        Effect.Do.pipe(
          Effect.let('boundedLimit', () => {
            const raw = Option.getOrElse(limit, () => 20);
            const normalized = Number.isFinite(raw) ? Math.trunc(raw) : 20;
            return Math.min(100, Math.max(1, normalized));
          }),
          Effect.bind('mappingsRepo', () => DiscordChannelMappingRepository.asEffect()),
          Effect.bind('groups', ({ mappingsRepo, boundedLimit }) =>
            mappingsRepo.findGroupsMissingRole(team_id, boundedLimit),
          ),
          Effect.tap(({ groups }) =>
            Effect.logInfo(
              `BackfillMissingGroupRoles: found ${groups.length} groups missing a role`,
            ),
          ),
          Effect.bind('count', ({ groups }) =>
            Effect.forEach(groups, emitMissingGroupRoleProvision, { concurrency: 1 }).pipe(
              Effect.map((results) => results.length),
            ),
          ),
          Effect.tap(({ count }) =>
            Effect.logInfo(`BackfillMissingGroupRoles: enqueued ${count} provisioning events`),
          ),
          Effect.map(({ count }) => count),
        ),
  ),
  Bind.remove('syncEvents'),
  Bind.remove('mappings'),
  Bind.remove('rosters'),
  (handlers) => ChannelRpcGroup.ChannelRpcGroup.toLayer(handlers),
);
