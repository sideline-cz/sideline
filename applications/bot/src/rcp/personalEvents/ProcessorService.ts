import { Bind } from '@sideline/effect-lib';
import { Array as Arr, Effect } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';
import { deprovisionPersonalChannels } from './handleDeprovision.js';
import { provisionPersonalChannels } from './handleProvision.js';
import { reconcileEvent } from './handleReconcile.js';
import { renamePersonalChannels } from './handleRename.js';

const PROVISION_BATCH = 20;
const RECONCILE_BATCH = 20;

/**
 * PersonalEventsSyncService — provides a processTick for the bot poll loop.
 *
 * Each tick runs two independent passes:
 *
 * PASS 1 — PROVISION (event-independent):
 *   GetGuildsNeedingPersonalProvisioning → for each guild_id, provisionPersonalChannels.
 *   Covers: backfill when a category is first configured, and new member joins.
 *   Per-guild failures are isolated.
 *
 * PASS 2 — RECONCILE (event-driven):
 *   GetEventsNeedingReconcile → for each {event_id, team_id, guild_id}:
 *     reconcileEvent → ClearPersonalMessagesDirty.
 *   Per-event failures are isolated.
 */
export const ProcessorService = Effect.Do.pipe(
  Effect.tap(() => Effect.logInfo('PersonalEventsSyncService initialized')),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.let('processTick', ({ rpc }) =>
    // ── PASS 1: PROVISION ──────────────────────────────────────────────────
    rpc['Guild/GetGuildsNeedingPersonalProvisioning']({ limit: PROVISION_BATCH }).pipe(
      Effect.tap((guilds) =>
        guilds.length > 0
          ? Effect.logDebug(`Personal events: provisioning ${guilds.length} guild(s)`)
          : Effect.void,
      ),
      Effect.flatMap((guilds) =>
        Effect.all(
          Arr.map(guilds, (guildId) =>
            provisionPersonalChannels(guildId).pipe(
              // De-provision members who fell outside the configured group.
              Effect.andThen(deprovisionPersonalChannels(guildId)),
              // Rename channels whose name format changed.
              Effect.andThen(renamePersonalChannels(guildId)),
              Effect.catchCause((cause) =>
                Effect.logWarning(`Provision failed for guild ${guildId}, skipping`, cause),
              ),
            ),
          ),
          { concurrency: 1 },
        ),
      ),
      Effect.asVoid,
      // ── PASS 2: RECONCILE ─────────────────────────────────────────────────
      Effect.andThen(
        rpc['PersonalEvents/GetEventsNeedingReconcile']({ limit: RECONCILE_BATCH }).pipe(
          Effect.tap((items) =>
            items.length > 0
              ? Effect.logDebug(`Personal events: ${items.length} event(s) pending reconcile`)
              : Effect.void,
          ),
          Effect.flatMap((items) =>
            Effect.all(
              Arr.map(items, (item) =>
                reconcileEvent(item).pipe(
                  Effect.flatMap(() =>
                    rpc['PersonalEvents/ClearPersonalMessagesDirty']({
                      event_id: item.event_id,
                      dirty_at: item.dirty_at,
                    }).pipe(
                      Effect.catchTag('RpcClientError', (e) =>
                        Effect.logWarning(
                          `Failed to clear dirty flag for event ${item.event_id}`,
                          e,
                        ),
                      ),
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logWarning(`Reconcile failed for event ${item.event_id}`, cause),
                  ),
                ),
              ),
              { concurrency: 1 },
            ),
          ),
          Effect.asVoid,
        ),
      ),
      Effect.tapError((error) => Effect.logError('Error in personal events tick', error)),
    ),
  ),
  Bind.remove('rpc'),
);
