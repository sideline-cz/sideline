import { RoleRpcEvents, type RoleSyncEvent } from '@sideline/domain';
import { Data, Effect, Match } from 'effect';
import {
  type EventRow,
  RoleSyncEventsRepository,
} from '~/repositories/RoleSyncEventsRepository.js';
import { makeNullableEventProperty } from '~/utils/nullableEventProperty.js';

export class EventPropertyMissing extends Data.TaggedError('EventPropertyMissing')<{
  event_type: string;
  id: RoleSyncEvent.RoleSyncEventId;
  property: string;
}> {
  errorMessage = () =>
    `Property "${this.property}" is missing for event "${this.event_type}" with id "${this.id}"`;

  log = () => Effect.logError(this.errorMessage());

  markFailed = () =>
    RoleSyncEventsRepository.asEffect().pipe(
      Effect.flatMap((repository) => repository.markFailed(this.id, this.errorMessage())),
    );

  static handle = (e: EventPropertyMissing) => e.log().pipe(Effect.tap(() => e.markFailed()));
}

const nullable = makeNullableEventProperty<RoleSyncEvent.RoleSyncEventId, EventPropertyMissing>(
  (args) => new EventPropertyMissing(args),
);

export const constructEvent = Match.type<EventRow>().pipe(
  Match.when({ event_type: 'role_created' }, (r) =>
    Effect.Do.pipe(
      Effect.bind('role_name', () => nullable(r, 'role_name')),
      Effect.tap((extras) =>
        Effect.logInfo(
          `Constructing role_created event with ${JSON.stringify(r)} and ${JSON.stringify(extras)}`,
        ),
      ),
      Effect.map(
        ({ role_name }) =>
          new RoleRpcEvents.RoleCreatedEvent({
            id: r.id,
            team_id: r.team_id,
            guild_id: r.guild_id,
            role_id: r.role_id,
            role_name,
          }),
      ),
    ),
  ),
  Match.when({ event_type: 'role_deleted' }, (r) =>
    Effect.succeed(
      new RoleRpcEvents.RoleDeletedEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        role_id: r.role_id,
      }),
    ).pipe(
      Effect.tap((extras) =>
        Effect.logInfo(
          `Constructing role_deleted event with ${JSON.stringify(r)} and ${JSON.stringify(extras)}`,
        ),
      ),
    ),
  ),
  Match.when({ event_type: 'role_assigned' }, (r) =>
    Effect.Do.pipe(
      Effect.bind('discord_user_id', () => nullable(r, 'discord_user_id')),
      Effect.bind('team_member_id', () => nullable(r, 'team_member_id')),
      Effect.bind('role_name', () => nullable(r, 'role_name')),
      Effect.tap((extras) =>
        Effect.logInfo(
          `Constructing role_assigned event with ${JSON.stringify(r)} and ${JSON.stringify(extras)}`,
        ),
      ),
      Effect.map(
        ({ discord_user_id, team_member_id, role_name }) =>
          new RoleRpcEvents.RoleAssignedEvent({
            id: r.id,
            team_id: r.team_id,
            guild_id: r.guild_id,
            role_id: r.role_id,
            role_name,
            discord_user_id,
            team_member_id,
          }),
      ),
    ),
  ),
  Match.when({ event_type: 'role_unassigned' }, (r) =>
    Effect.Do.pipe(
      Effect.bind('discord_user_id', () => nullable(r, 'discord_user_id')),
      Effect.bind('team_member_id', () => nullable(r, 'team_member_id')),
      Effect.tap((extras) =>
        Effect.logInfo(
          `Constructing role_unassigned event with ${JSON.stringify(r)} and ${JSON.stringify(extras)}`,
        ),
      ),
      Effect.map(
        ({ discord_user_id, team_member_id }) =>
          new RoleRpcEvents.RoleUnassignedEvent({
            id: r.id,
            team_id: r.team_id,
            guild_id: r.guild_id,
            role_id: r.role_id,
            discord_user_id,
            team_member_id,
          }),
      ),
    ),
  ),
  Match.exhaustive,
);
