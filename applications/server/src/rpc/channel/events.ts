import { ChannelRpcEvents, type ChannelSyncEvent } from '@sideline/domain';
import { Data, Effect, Match, Option } from 'effect';
import {
  ChannelSyncEventsRepository,
  type EventRow,
} from '~/repositories/ChannelSyncEventsRepository.js';

export class EventPropertyMissing extends Data.TaggedError('EventPropertyMissing')<{
  event_type: string;
  id: ChannelSyncEvent.ChannelSyncEventId;
  property: string;
}> {
  errorMessage = () =>
    `Property "${this.property}" is missing for event "${this.event_type}" with id "${this.id}"`;

  log = () => Effect.logError(this.errorMessage());

  markPermanentlyFailed = () =>
    ChannelSyncEventsRepository.asEffect().pipe(
      Effect.flatMap((repository) =>
        repository.markPermanentlyFailed(this.id, this.errorMessage()),
      ),
    );

  static handle = (e: EventPropertyMissing) =>
    e.log().pipe(Effect.tap(() => e.markPermanentlyFailed()));
}

const nullable = <
  K extends keyof E & string,
  E extends {
    readonly event_type: string;
    readonly id: ChannelSyncEvent.ChannelSyncEventId;
  } & {
    [key in K]: E[K] extends Option.Option<infer T> ? Option.Option<T> : never;
  },
>(
  event: E,
  key: K,
) =>
  Effect.fromOption(event[key] as Option.Option<unknown>).pipe(
    Effect.catchTag('NoSuchElementError', () =>
      Effect.fail(
        new EventPropertyMissing({ event_type: event.event_type, id: event.id, property: key }),
      ),
    ),
  ) as Effect.Effect<E[K] extends Option.Option<infer T> ? T : never, EventPropertyMissing>;

const channelCreatedFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('group', () =>
      Effect.Do.pipe(
        Effect.bind('group_id', () => nullable(r, 'group_id')),
        Effect.bind('group_name', () => nullable(r, 'group_name')),
        Effect.map(
          ({ group_id, group_name }) =>
            new ChannelRpcEvents.GroupChannelCreatedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              group_id,
              group_name,
              existing_channel_id: r.existing_channel_id,
              discord_channel_name: r.discord_channel_name,
              discord_role_name: Option.getOrElse(r.discord_role_name, () => group_name),
              discord_role_color: r.discord_role_color,
            }),
        ),
      ),
    ),
    Match.when('roster', () =>
      Effect.Do.pipe(
        Effect.bind('roster_id', () => nullable(r, 'roster_id')),
        Effect.bind('roster_name', () => nullable(r, 'roster_name')),
        Effect.map(
          ({ roster_id, roster_name }) =>
            new ChannelRpcEvents.RosterChannelCreatedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              roster_id,
              roster_name,
              existing_channel_id: r.existing_channel_id,
              discord_channel_name: Option.getOrElse(r.discord_channel_name, () => roster_name),
              discord_role_name: Option.getOrElse(r.discord_role_name, () => roster_name),
              discord_role_color: r.discord_role_color,
              target_category_id: r.target_category_id,
            }),
        ),
      ),
    ),
    Match.when('managed', () =>
      Effect.Do.pipe(
        Effect.bind('team_channel_id', () => nullable(r, 'team_channel_id')),
        Effect.bind('discord_channel_name', () => nullable(r, 'discord_channel_name')),
        Effect.map(
          ({ team_channel_id, discord_channel_name }) =>
            new ChannelRpcEvents.ManagedChannelCreatedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              team_channel_id,
              discord_channel_name,
            }),
        ),
      ),
    ),
    // 'discord' entity_type never produces channel_created events — impossible-state guard.
    Match.when('discord', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(discord) is not valid for channel_created',
        }),
      ),
    ),
    Match.exhaustive,
  );

const channelDeletedFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('group', () =>
      Effect.Do.pipe(
        Effect.bind('group_id', () => nullable(r, 'group_id')),
        Effect.map(
          ({ group_id }) =>
            new ChannelRpcEvents.GroupChannelDeletedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              group_id,
              discord_channel_id: r.existing_channel_id,
              discord_role_id: r.discord_role_id,
            }),
        ),
      ),
    ),
    Match.when('roster', () =>
      Effect.Do.pipe(
        Effect.bind('roster_id', () => nullable(r, 'roster_id')),
        Effect.bind('discord_channel_id', () => nullable(r, 'existing_channel_id')),
        Effect.map(
          ({ roster_id, discord_channel_id }) =>
            new ChannelRpcEvents.RosterChannelDeletedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              roster_id,
              discord_channel_id,
              discord_role_id: r.discord_role_id,
            }),
        ),
      ),
    ),
    Match.when('managed', () =>
      Effect.Do.pipe(
        Effect.bind('team_channel_id', () => nullable(r, 'team_channel_id')),
        Effect.map(
          ({ team_channel_id }) =>
            new ChannelRpcEvents.ManagedChannelDeletedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              team_channel_id,
              discord_channel_id: r.existing_channel_id,
            }),
        ),
      ),
    ),
    // 'discord' entity_type never produces channel_deleted events — impossible-state guard.
    Match.when('discord', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(discord) is not valid for channel_deleted',
        }),
      ),
    ),
    Match.exhaustive,
  );

const memberAddedFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('group', () =>
      Effect.Do.pipe(
        Effect.bind('group_id', () => nullable(r, 'group_id')),
        Effect.bind('group_name', () => nullable(r, 'group_name')),
        Effect.bind('team_member_id', () => nullable(r, 'team_member_id')),
        Effect.bind('discord_user_id', () => nullable(r, 'discord_user_id')),
        Effect.map(
          ({ group_id, group_name, team_member_id, discord_user_id }) =>
            new ChannelRpcEvents.GroupMemberAddedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              group_id,
              group_name,
              team_member_id,
              discord_user_id,
            }),
        ),
      ),
    ),
    Match.when('roster', () =>
      Effect.Do.pipe(
        Effect.bind('roster_id', () => nullable(r, 'roster_id')),
        Effect.bind('roster_name', () => nullable(r, 'roster_name')),
        Effect.bind('team_member_id', () => nullable(r, 'team_member_id')),
        Effect.bind('discord_user_id', () => nullable(r, 'discord_user_id')),
        Effect.map(
          ({ roster_id, roster_name, team_member_id, discord_user_id }) =>
            new ChannelRpcEvents.RosterMemberAddedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              roster_id,
              roster_name,
              team_member_id,
              discord_user_id,
            }),
        ),
      ),
    ),
    Match.when('managed', () =>
      Effect.Do.pipe(
        Effect.bind('team_channel_id', () => nullable(r, 'team_channel_id')),
        Effect.bind('discord_channel_id', () => nullable(r, 'existing_channel_id')),
        Effect.bind('discord_role_id', () => nullable(r, 'discord_role_id')),
        Effect.bind('access_level', () => nullable(r, 'access_level')),
        Effect.map(
          ({ team_channel_id, discord_channel_id, discord_role_id, access_level }) =>
            new ChannelRpcEvents.ManagedChannelAccessGrantedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              team_channel_id,
              discord_channel_id,
              discord_role_id,
              access_level,
            }),
        ),
      ),
    ),
    // 'discord' entity_type never produces member_added events — impossible-state guard.
    Match.when('discord', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(discord) is not valid for member_added',
        }),
      ),
    ),
    Match.exhaustive,
  );

const memberRemovedFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('group', () =>
      Effect.Do.pipe(
        Effect.bind('group_id', () => nullable(r, 'group_id')),
        Effect.bind('team_member_id', () => nullable(r, 'team_member_id')),
        Effect.bind('discord_user_id', () => nullable(r, 'discord_user_id')),
        Effect.map(
          ({ group_id, team_member_id, discord_user_id }) =>
            new ChannelRpcEvents.GroupMemberRemovedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              group_id,
              team_member_id,
              discord_user_id,
            }),
        ),
      ),
    ),
    Match.when('roster', () =>
      Effect.Do.pipe(
        Effect.bind('roster_id', () => nullable(r, 'roster_id')),
        Effect.bind('team_member_id', () => nullable(r, 'team_member_id')),
        Effect.bind('discord_user_id', () => nullable(r, 'discord_user_id')),
        Effect.map(
          ({ roster_id, team_member_id, discord_user_id }) =>
            new ChannelRpcEvents.RosterMemberRemovedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              roster_id,
              team_member_id,
              discord_user_id,
            }),
        ),
      ),
    ),
    Match.when('managed', () =>
      Effect.Do.pipe(
        Effect.bind('discord_channel_id', () => nullable(r, 'existing_channel_id')),
        Effect.bind('discord_role_id', () => nullable(r, 'discord_role_id')),
        Effect.map(
          ({ discord_channel_id, discord_role_id }) =>
            new ChannelRpcEvents.ManagedChannelAccessRevokedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              discord_channel_id,
              discord_role_id,
            }),
        ),
      ),
    ),
    // 'discord' entity_type never produces member_removed events — impossible-state guard.
    Match.when('discord', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(discord) is not valid for member_removed',
        }),
      ),
    ),
    Match.exhaustive,
  );

const channelArchivedFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('group', () =>
      Effect.Do.pipe(
        Effect.bind('group_id', () => nullable(r, 'group_id')),
        Effect.bind('archive_category_id', () => nullable(r, 'archive_category_id')),
        Effect.map(
          ({ group_id, archive_category_id }) =>
            new ChannelRpcEvents.GroupChannelArchivedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              group_id,
              discord_channel_id: r.existing_channel_id,
              discord_role_id: r.discord_role_id,
              archive_category_id,
            }),
        ),
      ),
    ),
    Match.when('roster', () =>
      Effect.Do.pipe(
        Effect.bind('roster_id', () => nullable(r, 'roster_id')),
        Effect.bind('discord_channel_id', () => nullable(r, 'existing_channel_id')),
        Effect.bind('archive_category_id', () => nullable(r, 'archive_category_id')),
        Effect.map(
          ({ roster_id, discord_channel_id, archive_category_id }) =>
            new ChannelRpcEvents.RosterChannelArchivedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              roster_id,
              discord_channel_id,
              discord_role_id: r.discord_role_id,
              archive_category_id,
            }),
        ),
      ),
    ),
    Match.when('managed', () =>
      Effect.Do.pipe(
        Effect.bind('team_channel_id', () => nullable(r, 'team_channel_id')),
        Effect.bind('archive_category_id', () => nullable(r, 'archive_category_id')),
        Effect.map(
          ({ team_channel_id, archive_category_id }) =>
            new ChannelRpcEvents.ManagedChannelArchivedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              team_channel_id,
              discord_channel_id: r.existing_channel_id,
              archive_category_id,
            }),
        ),
      ),
    ),
    Match.when('discord', () =>
      Effect.Do.pipe(
        Effect.bind('archive_category_id', () => nullable(r, 'archive_category_id')),
        Effect.map(
          ({ archive_category_id }) =>
            new ChannelRpcEvents.DiscordChannelArchivedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              discord_channel_id: r.existing_channel_id,
              archive_category_id,
            }),
        ),
      ),
    ),
    Match.exhaustive,
  );

const channelDetachedFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('group', () =>
      Effect.Do.pipe(
        Effect.bind('group_id', () => nullable(r, 'group_id')),
        Effect.map(
          ({ group_id }) =>
            new ChannelRpcEvents.GroupChannelDetachedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              group_id,
              discord_channel_id: r.existing_channel_id,
              discord_role_id: r.discord_role_id,
            }),
        ),
      ),
    ),
    Match.when('roster', () =>
      Effect.Do.pipe(
        Effect.bind('roster_id', () => nullable(r, 'roster_id')),
        Effect.bind('discord_channel_id', () => nullable(r, 'existing_channel_id')),
        Effect.map(
          ({ roster_id, discord_channel_id }) =>
            new ChannelRpcEvents.RosterChannelDetachedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              roster_id,
              discord_channel_id,
              discord_role_id: r.discord_role_id,
            }),
        ),
      ),
    ),
    // 'managed' entity_type never produces channel_detached events — this branch is an impossible
    // state guard added only to satisfy Match.exhaustive after ChannelSyncEntityType was widened.
    Match.when('managed', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(managed) is not valid for channel_detached',
        }),
      ),
    ),
    // 'discord' entity_type never produces channel_detached events — impossible-state guard.
    Match.when('discord', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(discord) is not valid for channel_detached',
        }),
      ),
    ),
    Match.exhaustive,
  );

const channelUpdatedFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('group', () =>
      Effect.Do.pipe(
        Effect.bind('group_id', () => nullable(r, 'group_id')),
        Effect.bind('discord_channel_name', () => nullable(r, 'discord_channel_name')),
        Effect.bind('discord_role_name', () => nullable(r, 'discord_role_name')),
        Effect.map(
          ({ group_id, discord_channel_name, discord_role_name }) =>
            new ChannelRpcEvents.GroupChannelUpdatedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              group_id,
              discord_channel_id: r.existing_channel_id,
              discord_role_id: r.discord_role_id,
              discord_channel_name,
              discord_role_name,
              discord_role_color: r.discord_role_color,
            }),
        ),
      ),
    ),
    Match.when('roster', () =>
      Effect.Do.pipe(
        Effect.bind('roster_id', () => nullable(r, 'roster_id')),
        Effect.bind('discord_channel_id', () => nullable(r, 'existing_channel_id')),
        Effect.bind('discord_role_id', () => nullable(r, 'discord_role_id')),
        Effect.bind('discord_channel_name', () => nullable(r, 'discord_channel_name')),
        Effect.bind('discord_role_name', () => nullable(r, 'discord_role_name')),
        Effect.map(
          ({
            roster_id,
            discord_channel_id,
            discord_role_id,
            discord_channel_name,
            discord_role_name,
          }) =>
            new ChannelRpcEvents.RosterChannelUpdatedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              roster_id,
              discord_channel_id,
              discord_role_id,
              discord_channel_name,
              discord_role_name,
              discord_role_color: r.discord_role_color,
            }),
        ),
      ),
    ),
    Match.when('managed', () =>
      Effect.Do.pipe(
        Effect.bind('team_channel_id', () => nullable(r, 'team_channel_id')),
        Effect.bind('discord_channel_id', () => nullable(r, 'existing_channel_id')),
        Effect.map(
          ({ team_channel_id, discord_channel_id }) =>
            new ChannelRpcEvents.ManagedChannelAdoptedEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              team_channel_id,
              discord_channel_id,
            }),
        ),
      ),
    ),
    // 'discord' entity_type never produces channel_updated events — impossible-state guard.
    Match.when('discord', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(discord) is not valid for channel_updated',
        }),
      ),
    ),
    Match.exhaustive,
  );

const channelRestoredFromSql = (r: EventRow) =>
  Match.value(r.entity_type).pipe(
    Match.when('managed', () =>
      Effect.Do.pipe(
        Effect.bind('team_channel_id', () => nullable(r, 'team_channel_id')),
        Effect.map(
          ({ team_channel_id }) =>
            new ChannelRpcEvents.ManagedChannelRestoredEvent({
              id: r.id,
              team_id: r.team_id,
              guild_id: r.guild_id,
              team_channel_id,
              discord_channel_id: r.existing_channel_id,
            }),
        ),
      ),
    ),
    Match.when('discord', () =>
      Effect.succeed(
        new ChannelRpcEvents.DiscordChannelRestoredEvent({
          id: r.id,
          team_id: r.team_id,
          guild_id: r.guild_id,
          discord_channel_id: r.existing_channel_id,
        }),
      ),
    ),
    // 'group' and 'roster' entity types never produce channel_restored events.
    Match.when('group', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(group) is not valid for channel_restored',
        }),
      ),
    ),
    Match.when('roster', () =>
      Effect.fail(
        new EventPropertyMissing({
          event_type: r.event_type,
          id: r.id,
          property: 'entity_type(roster) is not valid for channel_restored',
        }),
      ),
    ),
    Match.exhaustive,
  );

export const constructEvent = Match.type<EventRow>().pipe(
  Match.when({ event_type: 'channel_created' }, channelCreatedFromSql),
  Match.when({ event_type: 'channel_updated' }, channelUpdatedFromSql),
  Match.when({ event_type: 'channel_deleted' }, channelDeletedFromSql),
  Match.when({ event_type: 'channel_archived' }, channelArchivedFromSql),
  Match.when({ event_type: 'channel_restored' }, channelRestoredFromSql),
  Match.when({ event_type: 'channel_detached' }, channelDetachedFromSql),
  Match.when({ event_type: 'member_added' }, memberAddedFromSql),
  Match.when({ event_type: 'member_removed' }, memberRemovedFromSql),
  Match.exhaustive,
);
