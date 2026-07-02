import type { ChannelRpcEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Match, Metric } from 'effect';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '~/metrics.js';
import { isPermanentError } from '~/rest/discordErrors.js';
import { POLL_BATCH_SIZE } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { handleGroupArchived, handleRosterArchived } from './handleArchived.js';
import { handleCreated } from './handleCreated.js';
import { handleDeleted, handleRosterDeleted } from './handleDeleted.js';
import { handleGroupDetached, handleRosterDetached } from './handleDetached.js';
import { handleDiscordArchived } from './handleDiscordArchived.js';
import { handleDiscordRestored } from './handleDiscordRestored.js';
import { handleManagedAccessGranted, handleManagedAccessRevoked } from './handleManagedAccess.js';
import { handleManagedAdopted } from './handleManagedAdopted.js';
import { handleManagedArchived } from './handleManagedArchived.js';
import { handleManagedCreated } from './handleManagedCreated.js';
import { handleManagedDeleted } from './handleManagedDeleted.js';
import { handleManagedRestored } from './handleManagedRestored.js';
import { handleMemberAdded, handleRosterMemberAdded } from './handleMemberAdded.js';
import { handleMemberRemoved, handleRosterMemberRemoved } from './handleMemberRemoved.js';
import { handleRosterChannelCreated } from './handleRosterChannelCreated.js';
import { handleRosterRoleReconcile } from './handleRosterRoleReconcile.js';
import { handleGroupChannelUpdated, handleRosterChannelUpdated } from './handleUpdated.js';

// Split into two pipe chains to stay within the 20-argument overload limit.
const actionMatcher = Match.type<ChannelRpcEvents.UnprocessedChannelEvent>().pipe(
  Match.tag('group_channel_created', handleCreated),
  Match.tag('roster_channel_created', handleRosterChannelCreated),
  Match.tag('group_channel_updated', handleGroupChannelUpdated),
  Match.tag('roster_channel_updated', handleRosterChannelUpdated),
  Match.tag('group_channel_deleted', handleDeleted),
  Match.tag('roster_channel_deleted', handleRosterDeleted),
  Match.tag('group_channel_archived', handleGroupArchived),
  Match.tag('roster_channel_archived', handleRosterArchived),
  Match.tag('group_channel_detached', handleGroupDetached),
  Match.tag('roster_channel_detached', handleRosterDetached),
  Match.tag('group_member_added', handleMemberAdded),
  Match.tag('roster_member_added', handleRosterMemberAdded),
  Match.tag('group_member_removed', handleMemberRemoved),
  Match.tag('roster_member_removed', handleRosterMemberRemoved),
  Match.tag('managed_channel_created', handleManagedCreated),
  Match.tag('managed_channel_archived', handleManagedArchived),
  Match.tag('managed_channel_deleted', handleManagedDeleted),
  Match.tag('managed_access_granted', handleManagedAccessGranted),
);

const action: (
  event: ChannelRpcEvents.UnprocessedChannelEvent,
) => Effect.Effect<void, unknown, SyncRpc | DiscordREST> = actionMatcher.pipe(
  Match.tag('managed_access_revoked', handleManagedAccessRevoked),
  Match.tag('discord_channel_archived', handleDiscordArchived),
  Match.tag('managed_channel_adopted', handleManagedAdopted),
  Match.tag('managed_channel_restored', handleManagedRestored),
  Match.tag('discord_channel_restored', handleDiscordRestored),
  Match.tag('roster_role_reconcile', handleRosterRoleReconcile),
  Match.exhaustive,
);

// The permanent/transient classifier lives in `~/rest/discordErrors.ts` (shared with the
// tagged-error mapper). Re-exported here so channel-sync retry predicates keep importing it
// from their subsystem (`Effect.retry({ while: (e) => !isPermanentError(e) })`).
export { isPermanentError };

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: ChannelRpcEvents.UnprocessedChannelEvent) =>
        action(event).pipe(
          Effect.flatMap(() => rpc['Channel/MarkEventProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'channel' }),
                { action: event._tag },
              ),
              1,
            ),
          ),
          Effect.catch((error) =>
            (isPermanentError(error)
              ? rpc['Channel/MarkEventPermanentlyFailed']({
                  id: event.id,
                  error: String(error),
                })
              : rpc['Channel/MarkEventFailed']({ id: event.id, error: String(error) })
            ).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Failed to process channel sync event ${event.id}`, error),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'channel' }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan(`sync/channel/${event._tag}`, {
            attributes: { 'event.id': String(event.id) },
          }),
        ),
  ),
);

export const ProcessorService = Effect.Do.pipe(
  Effect.tap(() => Effect.logInfo('ChannelSyncService initialized')),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.bind('processEvent', ({ rpc, discord }) =>
    processEvent.pipe(
      Effect.provideService(SyncRpc, rpc),
      Effect.provideService(DiscordREST, discord),
    ),
  ),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['Channel/GetUnprocessedEvents']({ limit: POLL_BATCH_SIZE }).pipe(
      Effect.tap((events) => Effect.logDebug(`Channel sync poll: ${events.length} event(s)`)),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() => Effect.logInfo(`Processed ${events.length} channel sync event(s)`)),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling channel sync events', error)),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
