import { Array, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';

export const coachingStatusCronEffect = Effect.Do.pipe(
  Effect.bind('settingsRepo', () => TeamSettingsRepository.asEffect()),
  Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
  Effect.bind('syncRepo', () => EventSyncEventsRepository.asEffect()),
  Effect.bind('mappingRepo', () => DiscordChannelMappingRepository.asEffect()),
  Effect.tap(() => Effect.logInfo('CoachingStatusCron: starting cycle')),
  Effect.bind('events', ({ settingsRepo }) => settingsRepo.findEventsNeedingCoachingStatus()),
  Effect.tap(({ events, syncRepo, eventsRepo, mappingRepo }) =>
    Effect.all(
      Array.map(events, (event) =>
        Effect.Do.pipe(
          Effect.flatMap(() => {
            // Resolve the target channel via the event's owner-group channel mapping.
            if (Option.isNone(event.owner_group_id)) {
              return Effect.succeed(Option.none());
            }

            return mappingRepo
              .findByGroupId(event.team_id, event.owner_group_id.value)
              .pipe(Effect.map((mapping) => Option.flatMap(mapping, (m) => m.discord_channel_id)));
          }),
          Effect.flatMap((resolvedChannel) => {
            if (Option.isNone(resolvedChannel)) {
              return Effect.logWarning(
                `CoachingStatusCron: no channel resolved for event ${event.event_id}, marking sent to avoid rescan`,
              ).pipe(Effect.tap(() => eventsRepo.markCoachingStatusSent(event.event_id)));
            }

            const channelId = resolvedChannel.value;
            return syncRepo
              .emitCoachingStatus(
                event.team_id,
                event.event_id,
                event.title,
                event.start_at,
                channelId,
                event.claimed_by,
                event.claimer_display_name,
              )
              .pipe(
                Effect.tap(() => eventsRepo.markCoachingStatusSent(event.event_id)),
                Effect.tap(() =>
                  Effect.logInfo(
                    `CoachingStatusCron: emitted coaching status for event "${event.title}" (${event.event_id})`,
                  ),
                ),
              );
          }),
          Effect.tapError((e) =>
            Effect.logWarning(`CoachingStatusCron: failed for event ${event.event_id}`, e),
          ),
          Effect.exit,
        ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ events }) =>
    Effect.logInfo(
      `CoachingStatusCron: cycle complete, ${String(events.length)} event(s) processed`,
    ),
  ),
  Effect.asVoid,
  withCronMetrics('coaching-status'),
);

const cronSchedule = Schedule.cron('* * * * *');

export const CoachingStatusCron = coachingStatusCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
