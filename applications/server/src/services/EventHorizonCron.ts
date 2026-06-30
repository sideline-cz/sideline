import { Array, DateTime, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { resolveChannel } from '~/services/EventChannelResolver.js';
import { computeHorizonEnd, generateOccurrenceDates } from '~/services/RecurrenceService.js';
import { emitTrainingClaimRequestIfApplicable } from '~/services/TrainingClaimEmitter.js';

export const eventHorizonCronEffect = Effect.Do.pipe(
  Effect.bind('seriesRepo', () => EventSeriesRepository.asEffect()),
  Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
  Effect.bind('syncEvents', () => EventSyncEventsRepository.asEffect()),
  Effect.tap(() => Effect.logInfo('EventHorizonCron: starting generation cycle')),
  Effect.bind('allSeries', ({ seriesRepo }) => seriesRepo.getActiveForGeneration()),
  Effect.tap(({ allSeries, seriesRepo, eventsRepo, syncEvents }) =>
    Effect.all(
      Array.map(allSeries, (s) => {
        const effectiveEnd = computeHorizonEnd({
          seriesEndDate: Option.getOrNull(s.end_date),
          horizonDays: s.event_horizon_days,
        });

        const startFrom = Option.match(s.last_generated_date, {
          onNone: () => s.start_date,
          onSome: (d) => DateTime.add(d, { days: 1 }),
        });

        if (DateTime.isGreaterThan(startFrom, effectiveEnd)) return Effect.void;

        const dates = generateOccurrenceDates({
          frequency: s.frequency,
          daysOfWeek: s.days_of_week,
          startDate: startFrom,
          endDate: effectiveEnd,
        });

        if (dates.length === 0) return Effect.void;

        return Effect.all(
          Array.map(dates, (date) => {
            const dateStr = DateTime.formatIsoDateUtc(date);
            const startAt = DateTime.makeUnsafe(`${dateStr}T${s.start_time}Z`);
            const endAt = Option.map(s.end_time, (t) => DateTime.makeUnsafe(`${dateStr}T${t}Z`));
            return eventsRepo
              .insertEvent({
                teamId: s.team_id,
                trainingTypeId: s.training_type_id,
                eventType: 'training',
                title: s.title,
                description: s.description,
                startAt,
                endAt,
                location: s.location,
                locationUrl: s.location_url,
                createdBy: s.created_by,
                seriesId: Option.some(s.id),
                ownerGroupId: s.owner_group_id,
                memberGroupId: s.member_group_id,
              })
              .pipe(
                Effect.tap((event) =>
                  resolveChannel(s.team_id).pipe(
                    Effect.flatMap((resolved) =>
                      syncEvents.emitEventCreated(
                        s.team_id,
                        event.id,
                        event.title,
                        event.description,
                        event.start_at,
                        event.end_at,
                        event.location,
                        event.event_type,
                        resolved,
                        Option.none(),
                        Option.none(),
                        Option.none(),
                        event.location_url,
                      ),
                    ),
                    Effect.tapDefect((defect) =>
                      Effect.logWarning('EventHorizonCron: failed to emit sync event', defect),
                    ),
                    Effect.catchDefect(() => Effect.void),
                  ),
                ),
                Effect.tap((event) =>
                  emitTrainingClaimRequestIfApplicable({
                    teamId: s.team_id,
                    eventId: event.id,
                    eventType: event.event_type,
                    ownerGroupId: event.owner_group_id,
                    title: event.title,
                    description: event.description,
                    startAt: event.start_at,
                    endAt: event.end_at,
                    location: event.location,
                    locationUrl: event.location_url,
                  }),
                ),
              );
          }),
          { concurrency: 1 },
        ).pipe(
          Effect.tap(() => seriesRepo.updateLastGeneratedDate(s.id, effectiveEnd)),
          Effect.tap(() =>
            Effect.logInfo(
              `EventHorizonCron: series ${s.id} — ${String(dates.length)} events generated`,
            ),
          ),
        );
      }),
    ),
  ),
  Effect.tap(() => Effect.logInfo('EventHorizonCron: generation cycle complete')),
  Effect.asVoid,
  withCronMetrics('event-horizon'),
);

const cronSchedule = Schedule.cron('0 3 * * *');

export const EventHorizonCron = eventHorizonCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
