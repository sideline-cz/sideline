import { Array, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';

export const trainingClaimRequestCronEffect = Effect.Do.pipe(
  Effect.bind('settingsRepo', () => TeamSettingsRepository.asEffect()),
  Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
  Effect.bind('syncRepo', () => EventSyncEventsRepository.asEffect()),
  Effect.bind('mappingRepo', () => DiscordChannelMappingRepository.asEffect()),
  Effect.tap(() => Effect.logInfo('TrainingClaimRequestCron: starting cycle')),
  Effect.bind('events', ({ settingsRepo }) => settingsRepo.findEventsNeedingClaimRequest()),
  Effect.tap(({ events, syncRepo, eventsRepo, mappingRepo }) =>
    Effect.all(
      Array.map(events, (event) => {
        return Effect.Do.pipe(
          Effect.flatMap(() => {
            if (Option.isNone(event.owner_group_id)) {
              return Effect.logWarning(
                `TrainingClaimRequestCron: no owner_group_id for event ${event.event_id}, marking sent to avoid rescan`,
              ).pipe(Effect.tap(() => eventsRepo.markClaimRequestSent(event.event_id)));
            }

            return mappingRepo.findByGroupId(event.team_id, event.owner_group_id.value).pipe(
              Effect.flatMap((mapping) => {
                if (Option.isNone(mapping) || Option.isNone(mapping.value.discord_channel_id)) {
                  return Effect.logWarning(
                    `TrainingClaimRequestCron: no owner channel for event ${event.event_id}, marking sent to avoid rescan`,
                  ).pipe(Effect.tap(() => eventsRepo.markClaimRequestSent(event.event_id)));
                }

                const channelId = mapping.value.discord_channel_id.value;
                return syncRepo
                  .emitTrainingClaimRequest(
                    event.team_id,
                    event.event_id,
                    event.title,
                    event.start_at,
                    event.end_at,
                    event.location,
                    event.description,
                    channelId,
                    mapping.value.discord_role_id,
                  )
                  .pipe(
                    Effect.tap(() => eventsRepo.markClaimRequestSent(event.event_id)),
                    Effect.tap(() =>
                      Effect.logInfo(
                        `TrainingClaimRequestCron: emitted claim request for event "${event.title}" (${event.event_id})`,
                      ),
                    ),
                  );
              }),
            );
          }),
          Effect.tapError((e) =>
            Effect.logWarning(`TrainingClaimRequestCron: failed for event ${event.event_id}`, e),
          ),
          Effect.exit,
        );
      }),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ events }) =>
    Effect.logInfo(
      `TrainingClaimRequestCron: cycle complete, ${String(events.length)} event(s) processed`,
    ),
  ),
  Effect.asVoid,
  withCronMetrics('training-claim-request'),
);

const cronSchedule = Schedule.cron('* * * * *');

export const TrainingClaimRequestCron = trainingClaimRequestCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
