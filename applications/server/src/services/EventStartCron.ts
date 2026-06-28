import { Array, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { resolveGroupRoleId, resolveReminderChannel } from '~/services/EventChannelResolver.js';

export const eventStartCronEffect = Effect.Do.pipe(
  Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
  Effect.bind('syncRepo', () => EventSyncEventsRepository.asEffect()),
  Effect.bind('eventsRsvpsRepo', () => EventRsvpsRepository.asEffect()),
  Effect.tap(() => Effect.logInfo('EventStartCron: starting cycle')),
  Effect.bind('events', ({ eventsRepo }) => eventsRepo.findEventsToStart()),
  Effect.tap(({ events, syncRepo, eventsRepo, eventsRsvpsRepo }) =>
    Effect.all(
      Array.map(events, (event) =>
        Effect.Do.pipe(
          Effect.bind('startResult', () => eventsRepo.startEvent(event.id)),
          Effect.flatMap(({ startResult }) =>
            Option.match(startResult, {
              onNone: () =>
                Effect.logDebug(
                  `EventStartCron: event "${event.title}" (${event.id}) no longer active, skipping`,
                ).pipe(Effect.asVoid),
              onSome: () =>
                Effect.Do.pipe(
                  // Increment missed-RSVP counters immediately after active→started flip,
                  // before Discord resolution so a Discord failure can't cause the increment
                  // to be lost (the event won't reprocess since it's already started).
                  Effect.tap(() =>
                    eventsRsvpsRepo
                      .incrementMissedForEventNonRespondersByEventId(
                        event.id,
                        event.team_id,
                        event.member_group_id,
                      )
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            `EventStartCron: failed to increment missed RSVPs for event ${event.id}, continuing`,
                            cause,
                          ),
                        ),
                      ),
                  ),
                  Effect.bind('discordRoleId', () =>
                    event.event_type === 'training'
                      ? resolveGroupRoleId(event.team_id, event.owner_group_id)
                      : resolveGroupRoleId(event.team_id, event.member_group_id),
                  ),
                  Effect.bind('channel', () =>
                    resolveReminderChannel(
                      event.team_id,
                      event.owner_group_id,
                      event.reminders_channel_id,
                    ),
                  ),
                  Effect.flatMap(({ discordRoleId, channel }) =>
                    syncRepo.emitEventStarted(
                      event.team_id,
                      event.id,
                      event.title,
                      event.description,
                      event.start_at,
                      event.end_at,
                      event.location,
                      event.event_type,
                      channel,
                      event.member_group_id,
                      discordRoleId,
                      event.image_url,
                      event.location_url,
                      event.all_day,
                      event.event_type === 'training' ? event.claimed_by : Option.none(),
                    ),
                  ),
                  Effect.tap(() =>
                    Effect.logInfo(
                      `EventStartCron: marked event "${event.title}" (${event.id}) as started`,
                    ),
                  ),
                ),
            }),
          ),
          Effect.tapError((e) =>
            Effect.logWarning(
              `EventStartCron: failed post-start processing for event ${event.id}`,
              e,
            ),
          ),
          Effect.exit,
        ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ events }) =>
    Effect.logInfo(`EventStartCron: cycle complete, ${String(events.length)} event(s) processed`),
  ),
  Effect.asVoid,
  withCronMetrics('event-start'),
);

const cronSchedule = Schedule.cron('* * * * *');

export const EventStartCron = eventStartCronEffect.pipe(Effect.repeat(cronSchedule), Effect.asVoid);
