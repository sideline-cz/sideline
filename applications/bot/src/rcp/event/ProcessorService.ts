import type { EventRpcEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Match, Metric } from 'effect';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '~/metrics.js';
import { POLL_BATCH_SIZE } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { ChannelReorderSemaphore } from './ChannelReorderSemaphore.js';
import { handleCancelled } from './handleCancelled.js';
import { handleChannelMoved } from './handleChannelMoved.js';
import { handleCoachingStatus } from './handleCoachingStatus.js';
import { handleCreated } from './handleCreated.js';
import { handleEventRosterApprovalCancel } from './handleEventRosterApprovalCancel.js';
import { handleEventRosterApprovalRequest } from './handleEventRosterApprovalRequest.js';
import { handleEventRosterThreadDelete } from './handleEventRosterThreadDelete.js';
import { handleRsvpReminder } from './handleRsvpReminder.js';
import { handleStarted } from './handleStarted.js';
import { handleTeamsGenerated } from './handleTeamsGenerated.js';
import { handleTrainingClaimRequest } from './handleTrainingClaimRequest.js';
import { handleTrainingClaimUpdate } from './handleTrainingClaimUpdate.js';
import { handleUnclaimedTrainingReminder } from './handleUnclaimedTrainingReminder.js';
import { handleUpdated } from './handleUpdated.js';

const action: (
  event: EventRpcEvents.UnprocessedEventSyncEvent,
) => Effect.Effect<void, unknown, SyncRpc | DiscordREST | ChannelReorderSemaphore> =
  Match.type<EventRpcEvents.UnprocessedEventSyncEvent>().pipe(
    Match.tag('event_created', handleCreated),
    Match.tag('event_updated', handleUpdated),
    Match.tag('event_cancelled', handleCancelled),
    Match.tag('event_started', handleStarted),
    Match.tag('rsvp_reminder', handleRsvpReminder),
    Match.tag('training_claim_request', handleTrainingClaimRequest),
    Match.tag('training_claim_update', handleTrainingClaimUpdate),
    Match.tag('unclaimed_training_reminder', handleUnclaimedTrainingReminder),
    Match.tag('coaching_status', handleCoachingStatus),
    Match.tag('event_roster_approval_request', handleEventRosterApprovalRequest),
    Match.tag('event_roster_approval_cancel', handleEventRosterApprovalCancel),
    Match.tag('event_roster_thread_delete', handleEventRosterThreadDelete),
    Match.tag('teams_generated', handleTeamsGenerated),
    Match.tag('event_channel_moved', handleChannelMoved),
    Match.exhaustive,
  );

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.bind('semaphore', () => ChannelReorderSemaphore.asEffect()),
  Effect.map(
    ({ rpc, discord, semaphore }) =>
      (event: EventRpcEvents.UnprocessedEventSyncEvent) =>
        action(event).pipe(
          Effect.flatMap(() => rpc['Event/MarkEventProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'event' }),
                { action: event._tag },
              ),
              1,
            ),
          ),
          Effect.catch((error) =>
            rpc['Event/MarkEventFailed']({ id: event.id, error: String(error) }).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Failed to process event sync event ${event.id}`, error),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'event' }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.provideService(ChannelReorderSemaphore, semaphore),
          Effect.withSpan(`sync/event/${event._tag}`, {
            attributes: { 'event.id': String(event.id) },
          }),
        ),
  ),
);

export const ProcessorService = Effect.Do.pipe(
  Effect.tap(() => Effect.logInfo('EventSyncService initialized')),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.bind('semaphore', () => ChannelReorderSemaphore.asEffect()),
  Effect.bind('processEvent', ({ rpc, discord, semaphore }) =>
    processEvent.pipe(
      Effect.provideService(SyncRpc, rpc),
      Effect.provideService(DiscordREST, discord),
      Effect.provideService(ChannelReorderSemaphore, semaphore),
    ),
  ),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['Event/GetUnprocessedEvents']({ limit: POLL_BATCH_SIZE }).pipe(
      Effect.tap((events) => Effect.logDebug(`Event sync poll: ${events.length} event(s)`)),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() => Effect.logInfo(`Processed ${events.length} event sync event(s)`)),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling event sync events', error)),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('semaphore'),
  Bind.remove('processEvent'),
);
