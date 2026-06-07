import type { Event, GroupModel, Team } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';

const DEFAULT_CLAIM_REQUEST_DAYS_BEFORE = 3;

/**
 * Emit a `training_claim_request` for a newly created training when its owner
 * group resolves to a synced Discord channel AND the training's start time is
 * already within the team's `claim_request_days_before` lead-time window.
 *
 * - If the training starts OUTSIDE the lead-time window: no-op (the
 *   TrainingClaimRequestCron will emit the request when the window opens).
 * - If the training starts INSIDE the window: emits immediately and marks
 *   `claim_request_sent_at` so the cron does not double-post.
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
}): Effect.Effect<
  void,
  never,
  | EventSyncEventsRepository
  | DiscordChannelMappingRepository
  | TeamSettingsRepository
  | EventsRepository
> => {
  if (args.eventType !== 'training') return Effect.void;
  if (Option.isNone(args.ownerGroupId)) return Effect.void;

  const teamId = args.teamId;
  const ownerGroupId = args.ownerGroupId.value;

  return Effect.Do.pipe(
    Effect.bind('settings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('mappings', () => DiscordChannelMappingRepository.asEffect()),
    Effect.bind('syncEvents', () => EventSyncEventsRepository.asEffect()),
    Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
    Effect.bind('now', () => DateTime.now),
    Effect.bind('teamSettings', ({ settings }) => settings.findByTeamId(teamId)),
    Effect.let('claimRequestDaysBefore', ({ teamSettings }) =>
      Option.match(teamSettings, {
        onNone: () => DEFAULT_CLAIM_REQUEST_DAYS_BEFORE,
        onSome: (s) => s.claim_request_days_before,
      }),
    ),
    Effect.let('windowEnd', ({ now, claimRequestDaysBefore }) =>
      DateTime.add(now, { days: claimRequestDaysBefore }),
    ),
    Effect.flatMap(({ mappings, syncEvents, eventsRepo, windowEnd }) => {
      // Emit immediately only when the training is already within the lead-time window.
      // i.e. startAt <= now + claimRequestDaysBefore days
      if (!DateTime.isLessThanOrEqualTo(args.startAt, windowEnd)) {
        // Outside the window — the cron will handle it later.
        return Effect.void;
      }

      // Inside the window — resolve the owner channel and emit.
      return mappings.findByGroupId(teamId, ownerGroupId).pipe(
        Effect.flatMap((mapping) => {
          if (Option.isNone(mapping)) return Effect.void;
          if (Option.isNone(mapping.value.discord_channel_id)) return Effect.void;
          return syncEvents
            .emitTrainingClaimRequest(
              teamId,
              args.eventId,
              args.title,
              args.startAt,
              args.endAt,
              args.location,
              args.description,
              mapping.value.discord_channel_id.value,
              mapping.value.discord_role_id,
              args.locationUrl ?? Option.none(),
            )
            .pipe(Effect.tap(() => eventsRepo.markClaimRequestSent(args.eventId)));
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
