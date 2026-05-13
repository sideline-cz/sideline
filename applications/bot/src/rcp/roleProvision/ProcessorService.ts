import type { RoleProvisionRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Cause, Effect, Metric } from 'effect';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { POLL_BATCH_SIZE } from '../../rest/utils.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { handleProvisionRole } from './handleProvisionRole.js';

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: RoleProvisionRpcGroup.UnprocessedRoleProvisionEvent) =>
        handleProvisionRole(event).pipe(
          Effect.timeout('30 seconds'),
          Effect.flatMap(() => rpc['RoleProvision/MarkProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'role_provision' }),
              1,
            ),
          ),
          Effect.catch((error) =>
            rpc['RoleProvision/MarkFailed']({
              id: event.id,
              error: Cause.pretty(Cause.fail(error)),
            }).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Failed to process role provision event ${event.id}`, error),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, { sync_type: 'role_provision' }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan('sync/role_provision/provision_role', {
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
  Effect.tap(() => Effect.logInfo('RoleProvisionSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['RoleProvision/GetUnprocessedEvents']({ limit: POLL_BATCH_SIZE }).pipe(
      Effect.tap((events) =>
        Effect.logDebug(`Role provision sync poll: ${events.length} event(s)`),
      ),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${events.length} role provision sync event(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) =>
        Effect.logError('Error polling role provision sync events', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
