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
  // Once-per-cycle best-effort sweep, independent of the per-event loop below,
  // that self-heals events which fell out of the active/upcoming window while
  // still holding personal_event_messages rows (e.g. missed by the per-event
  // mark below in a prior cycle's failure).
  Effect.tap(({ eventsRepo }) =>
    eventsRepo
      .markStalePersonalMessagesDirty()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            'EventStartCron: stale personal-messages sweep failed, continuing',
            cause,
          ),
        ),
      ),
  ),
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
                  //
                  // DEFERRED entirely for all-day events (plan §4.8/§14.4/§15.4): `startEvent`'s
                  // flip leaves `missed_rsvp_counted_at` NULL ("armed") for them, and the
                  // deferred sweep below claims and increments once the event's last local
                  // day is over — penalising a member at team-local midnight for not having
                  // answered about an event they can still attend (and still RSVP to) would
                  // be wrong.
                  Effect.tap(() =>
                    event.all_day
                      ? Effect.void
                      : eventsRsvpsRepo
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
                  // Mark personal messages dirty immediately after the active→started
                  // flip, before Discord resolution/emit, so a Discord failure can't
                  // cause the mark to be lost (the event won't reprocess since it's
                  // already started). For an all-day event this is what makes the
                  // personal-events reconcile EDIT the message in place (picking up the
                  // "Dnes" marker, plan §4.6) instead of deleting it (plan §14.5) —
                  // always runs, for both branches.
                  Effect.tap(() =>
                    eventsRepo
                      .markEventPersonalMessagesDirty(event.id)
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            `EventStartCron: failed to mark personal messages dirty for event ${event.id}, continuing`,
                            cause,
                          ),
                        ),
                      ),
                  ),
                  // The `event_started` emit — the "Právě začíná"/"Starting now" post — is
                  // likewise DEFERRED for all-day events (plan §15.4): the flip at
                  // team-local midnight is silent; the morning sweep below claims
                  // `all_day_post_sent_at` and emits once, at the team's configured
                  // local time, with the all-day-specific "Dnes: {title}" title
                  // (`applications/bot/src/rcp/event/handleStarted.ts`).
                  Effect.flatMap(() =>
                    event.all_day
                      ? Effect.void
                      : Effect.Do.pipe(
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
  // Deferred missed-RSVP sweep (plan §4.8.2/§14.4): all-day events whose last
  // local day has passed but whose counter is still armed. Claim-then-increment
  // in ONE transaction per event — "stamp after increment" would double-penalise
  // every non-responder on a crash between the two; claiming first and skipping
  // on a lost race is the safe direction.
  Effect.tap(({ eventsRepo, eventsRsvpsRepo }) =>
    eventsRepo.findAllDayEventsPastLastLocalDay(new Date()).pipe(
      Effect.flatMap((pastDueEvents) =>
        Effect.all(
          Array.map(pastDueEvents, (event) =>
            eventsRepo
              .withTransaction(
                Effect.Do.pipe(
                  Effect.bind('claimed', () => eventsRepo.claimMissedRsvpCount(event.id)),
                  Effect.tap(({ claimed }) =>
                    Option.match(claimed, {
                      onNone: () => Effect.void,
                      onSome: () =>
                        eventsRsvpsRepo.incrementMissedForEventNonRespondersByEventId(
                          event.id,
                          event.team_id,
                          event.member_group_id,
                        ),
                    }),
                  ),
                ),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `EventStartCron: deferred missed-RSVP sweep failed for event ${event.id}, continuing`,
                    cause,
                  ),
                ),
              ),
          ),
          { concurrency: 1 },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          'EventStartCron: deferred missed-RSVP sweep query failed, continuing',
          cause,
        ),
      ),
    ),
  ),
  // Deferred "Dnes" started-post sweep (plan §15.2): all-day events on their
  // first local day, past the team's configured `all_day_post_time`, not yet
  // posted. Same claim-then-act shape, one transaction per event.
  Effect.tap(({ eventsRepo, syncRepo }) =>
    eventsRepo.findAllDayEventsNeedingStartedPost(new Date()).pipe(
      Effect.flatMap((dueEvents) =>
        Effect.all(
          Array.map(dueEvents, (event) =>
            eventsRepo
              .withTransaction(
                Effect.Do.pipe(
                  Effect.bind('claimed', () => eventsRepo.claimStartedPost(event.id)),
                  Effect.flatMap(({ claimed }) =>
                    Option.match(claimed, {
                      onNone: () => Effect.void,
                      onSome: () =>
                        Effect.Do.pipe(
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
                        ),
                    }),
                  ),
                ),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `EventStartCron: deferred all-day started-post sweep failed for event ${event.id}, continuing`,
                    cause,
                  ),
                ),
              ),
          ),
          { concurrency: 1 },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          'EventStartCron: deferred all-day started-post sweep query failed, continuing',
          cause,
        ),
      ),
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
