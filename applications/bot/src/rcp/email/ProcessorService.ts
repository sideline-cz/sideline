import type { EmailRpcEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Metric } from 'effect';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { POLL_BATCH_SIZE } from '../../rest/utils.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { handleEmailPostEvent } from './handleEmailPostEvent.js';

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: EmailRpcEvents.UnprocessedEmailPostEvent) =>
        handleEmailPostEvent(event).pipe(
          Effect.flatMap(() =>
            rpc['Email/MarkEmailPostEventProcessed']({
              id: event.id,
              deliveredAt: DateTime.nowUnsafe(),
              email_message_id: event.email_message_id,
              kind: event.kind,
              posted_channel_id: event.target_channel_id,
            }),
          ),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'email' }),
                { action: event.kind },
              ),
              1,
            ),
          ),
          Effect.catch((error) =>
            rpc['Email/MarkEmailPostEventFailed']({
              id: event.id,
              error: String(error),
            }).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Failed to process email post event ${event.id}`, error),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'email' }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan(`sync/email/${event.kind}`, {
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
  Effect.tap(() => Effect.logInfo('EmailSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['Email/GetUnprocessedEmailPostEvents']({ limit: POLL_BATCH_SIZE }).pipe(
      Effect.tap((events) => Effect.logDebug(`Email sync poll: ${events.length} event(s)`)),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() => Effect.logInfo(`Processed ${events.length} email sync event(s)`)),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling email sync events', error)),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
