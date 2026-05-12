import type { AchievementRpcEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Match, Metric } from 'effect';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { POLL_BATCH_SIZE } from '../../rest/utils.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { handleAchievementEarned } from './handleAchievementEarned.js';

const action: (
  event: AchievementRpcEvents.UnprocessedAchievementEvent,
) => Effect.Effect<void, unknown, SyncRpc | DiscordREST> =
  Match.type<AchievementRpcEvents.UnprocessedAchievementEvent>().pipe(
    Match.tag('achievement_earned', handleAchievementEarned),
    Match.exhaustive,
  );

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: AchievementRpcEvents.UnprocessedAchievementEvent) =>
        action(event).pipe(
          Effect.flatMap(() => rpc['Achievement/MarkEventProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'achievement' }),
                { action: event._tag },
              ),
              1,
            ),
          ),
          Effect.catch((error) =>
            rpc['Achievement/MarkEventFailed']({ id: event.id, error: String(error) }).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Failed to process achievement sync event ${event.id}`, error),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'achievement' }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan(`sync/achievement/${event._tag}`, {
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
  Effect.tap(() => Effect.logInfo('AchievementSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['Achievement/GetUnprocessedEvents']({ limit: POLL_BATCH_SIZE }).pipe(
      Effect.tap((events) => Effect.logDebug(`Achievement sync poll: ${events.length} event(s)`)),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${events.length} achievement sync event(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling achievement sync events', error)),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
