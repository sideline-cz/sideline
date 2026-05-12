import type { Event, GroupModel, Team } from '@sideline/domain';
import type { DateTime } from 'effect';
import { Effect, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';

/**
 * Emit a `training_claim_request` for a newly created training when its owner
 * group resolves to a synced Discord channel. No-ops for non-training events
 * or when the owner group is unset / has no mapping.
 *
 * Used by all event-creation paths (bot RPC, web HTTP API, recurring series
 * generator) to keep the claim flow consistent.
 */
export const emitTrainingClaimRequestIfApplicable = (args: {
  readonly teamId: Team.TeamId;
  readonly eventId: Event.EventId;
  readonly eventType: string;
  readonly ownerGroupId: Option.Option<GroupModel.GroupId>;
  readonly title: string;
  readonly description: Option.Option<string>;
  readonly startAt: DateTime.Utc;
  readonly endAt: Option.Option<DateTime.Utc>;
  readonly location: Option.Option<string>;
  readonly locationUrl?: Option.Option<string>;
}): Effect.Effect<void, never, EventSyncEventsRepository | DiscordChannelMappingRepository> => {
  if (args.eventType !== 'training') return Effect.void;

  return Effect.Do.pipe(
    Effect.bind('mappings', () => DiscordChannelMappingRepository.asEffect()),
    Effect.bind('syncEvents', () => EventSyncEventsRepository.asEffect()),
    Effect.flatMap(({ mappings, syncEvents }) => {
      if (args.ownerGroupId._tag === 'None') return Effect.void;
      return mappings.findByGroupId(args.teamId, args.ownerGroupId.value).pipe(
        Effect.flatMap((mapping) => {
          if (mapping._tag === 'None') return Effect.void;
          if (mapping.value.discord_channel_id._tag === 'None') return Effect.void;
          return syncEvents.emitTrainingClaimRequest(
            args.teamId,
            args.eventId,
            args.title,
            args.startAt,
            args.endAt,
            args.location,
            args.description,
            mapping.value.discord_channel_id.value,
            mapping.value.discord_role_id,
            args.locationUrl ?? Option.none(),
          );
        }),
      );
    }),
    Effect.tapDefect((e) =>
      Effect.logWarning(
        `emitTrainingClaimRequestIfApplicable: failed for event ${args.eventId}`,
        e,
      ),
    ),
    Effect.catchDefect(() => Effect.void),
  );
};
