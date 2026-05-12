import {
  ChannelRpcGroup,
  ChannelRpcModels,
  type ChannelSyncEvent,
  type Discord,
  type DiscordChannelMapping,
  type GroupModel,
  type RosterModel,
  type Team,
} from '@sideline/domain';
import { Bind, LogicError } from '@sideline/effect-lib';
import { Array, Cause, Data, Effect, flow, Option, Result } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
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
        mappings.insert(team_id, group_id, discord_channel_id, discord_role_id),
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
        mappings.insertRoleOnly(team_id, group_id, discord_role_id),
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
  Bind.remove('syncEvents'),
  Bind.remove('mappings'),
  Bind.remove('rosters'),
  (handlers) => ChannelRpcGroup.ChannelRpcGroup.toLayer(handlers),
);
