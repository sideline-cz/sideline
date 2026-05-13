import type { WeeklySummaryRpcEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Match, Metric } from 'effect';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { handleWeeklySummaryReady } from './handleWeeklySummaryReady.js';

const action: (
  event: WeeklySummaryRpcEvents.UnprocessedWeeklySummaryEvent,
) => Effect.Effect<void, unknown, SyncRpc | DiscordREST> =
  Match.type<WeeklySummaryRpcEvents.UnprocessedWeeklySummaryEvent>().pipe(
    Match.tag('weekly_summary_ready', handleWeeklySummaryReady),
    Match.exhaustive,
  );

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: WeeklySummaryRpcEvents.UnprocessedWeeklySummaryEvent) =>
        action(event).pipe(
          Effect.flatMap(() =>
            rpc['WeeklySummary/MarkEventProcessed']({
              id: event.id,
              deliveredAt: DateTime.nowUnsafe(),
            }),
          ),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'weekly_summary' }),
                { action: event._tag },
              ),
              1,
            ),
          ),
          Effect.catch((error) =>
            rpc['WeeklySummary/MarkEventFailed']({ id: event.id, error: String(error) }).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Failed to process weekly summary sync event ${event.id}`, error),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'weekly_summary' }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan(`sync/weekly_summary/${event._tag}`, {
            attributes: { 'event.id': String(event.id) },
          }),
        ),
  ),
);

export const ProcessorService = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.bind('processEvent', ({ rpc, discord }) =>
    processEvent.pipe(
      Effect.provideService(SyncRpc, rpc),
      Effect.provideService(DiscordREST, discord),
    ),
  ),
  Effect.tap(() => Effect.logInfo('WeeklySummarySyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['WeeklySummary/GetUnprocessedEvents']().pipe(
      Effect.tap((events) =>
        Effect.logDebug(`Weekly summary sync poll: ${events.length} event(s)`),
      ),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${events.length} weekly summary sync event(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) =>
        Effect.logError('Error polling weekly summary sync events', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
