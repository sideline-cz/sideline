import type { RoleRpcEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Match, Metric, Option } from 'effect';
import { syncEventsProcessedTotal } from '../../metrics.js';
import { POLL_BATCH_SIZE } from '../../rest/utils.js';
import { GuildRolesCache } from '../../services/GuildRolesCache.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { recordSyncFailure } from '../recordSyncFailure.js';
import { classifyRoleSyncError } from './errorClassifier.js';
import { handleMemberAdded } from './handleAssigned.js';
import { handleCreated } from './handleCreated.js';
import { handleDeleted } from './handleDeleted.js';
import { handleMemberRemoved } from './handleUnassigned.js';

const action: (
  event: RoleRpcEvents.UnprocessedRoleEvent,
) => Effect.Effect<void, unknown, SyncRpc | DiscordREST | GuildRolesCache> =
  Match.type<RoleRpcEvents.UnprocessedRoleEvent>().pipe(
    Match.tag('role_created', handleCreated),
    Match.tag('role_deleted', handleDeleted),
    Match.tag('role_assigned', handleMemberAdded),
    Match.tag('role_unassigned', handleMemberRemoved),
    Match.exhaustive,
  );

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: RoleRpcEvents.UnprocessedRoleEvent) =>
        action(event).pipe(
          Effect.flatMap(() => rpc['Role/MarkEventProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'role' }),
                { action: event._tag },
              ),
              1,
            ),
          ),
          // 9b: the classifier's `terminal` flag (CC-0) decides whether `error_code` is sent at
          // all — a 429 or a Discord 5xx must never be recorded as a user-visible role-sync
          // failure (`team_members.last_role_sync_*`, written server-side only when `Some`).
          // `role_sync_events` itself is still marked processed either way; the level-based diff
          // (CC-10) re-derives the change on the next reconcile pass if it's still needed.
          Effect.catch((error) => {
            const classified = classifyRoleSyncError(error);
            return recordSyncFailure(
              rpc['Role/MarkEventFailed']({
                id: event.id,
                error: classified.detail,
                error_code: classified.terminal ? Option.some(classified.code) : Option.none(),
              }),
              {
                syncType: 'role',
                message: `Failed to process role sync event ${event.id} (${classified.code})`,
                error,
              },
            );
          }),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan(`sync/role/${event._tag}`, {
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
  Effect.tap(() => Effect.logInfo('RoleSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    // A fresh `GuildRolesCache` per tick (never a shared `Layer`) — see its doc comment. Building
    // it here means `Effect.repeat`'s re-execution of this whole Effect (`Bot.ts` `pollLoop`)
    // allocates a new, empty cache every poll, so a permission change made between two ticks is
    // observed on the very next one.
    Effect.Do.pipe(
      Effect.bind('rolesCache', () => GuildRolesCache.make),
      Effect.bind('events', () => rpc['Role/GetUnprocessedEvents']({ limit: POLL_BATCH_SIZE })),
      Effect.tap(({ events }) => Effect.logDebug(`Role sync poll: ${events.length} event(s)`)),
      Effect.flatMap(({ events, rolesCache }) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.provideService(GuildRolesCache, rolesCache),
              Effect.tap(() => Effect.logInfo(`Processed ${events.length} role sync event(s)`)),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling role sync events', error)),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
