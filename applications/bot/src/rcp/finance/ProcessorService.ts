import type { FinanceRpcEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Cause, Effect, Match, Metric } from 'effect';
import { syncEventsProcessedTotal } from '../../metrics.js';
import { POLL_BATCH_SIZE } from '../../rest/utils.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { recordSyncFailure } from '../recordSyncFailure.js';
import { handleBankTokenExpiring } from './handleBankTokenExpiring.js';
import { handlePaymentReminderReady } from './handlePaymentReminderReady.js';

// ---------------------------------------------------------------------------
// Pass 1 — payment reminders (`payment_reminder_sync_events`)
// ---------------------------------------------------------------------------

const action: (
  event: FinanceRpcEvents.UnprocessedPaymentReminderEvent,
) => Effect.Effect<void, unknown, SyncRpc | DiscordREST> =
  Match.type<FinanceRpcEvents.UnprocessedPaymentReminderEvent>().pipe(
    Match.tag('payment_reminder_ready', handlePaymentReminderReady),
    Match.exhaustive,
  );

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: FinanceRpcEvents.UnprocessedPaymentReminderEvent) =>
        action(event).pipe(
          Effect.flatMap(() => rpc['Finance/MarkPaymentReminderProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'finance' }),
                { action: event._tag },
              ),
              1,
            ),
          ),
          Effect.catch((error) =>
            recordSyncFailure(
              rpc['Finance/MarkPaymentReminderFailed']({
                id: event.id,
                error: Cause.pretty(Cause.fail(error)),
              }),
              {
                syncType: 'finance',
                message: `Failed to process finance sync event ${event.id}`,
                error,
              },
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan(`sync/finance/${event._tag}`, {
            attributes: { 'event.id': String(event.id) },
          }),
        ),
  ),
);

// ---------------------------------------------------------------------------
// Pass 2 — T10b bank-token-expiry DM (`bank_token_expiry_events`)
//
// A SEPARATE outbox table with its own read/ack RPCs (`Finance/GetUnprocessedBankTokenExpiryEvents`
// / `MarkBankTokenExpiryProcessed` / `MarkBankTokenExpiryFailed`) — `payment_reminder_sync_events`
// is FK'd to `fee_assignments` and has no equivalent for a team-level expiry warning. Structured
// the same way as Pass 1 (its own `Match.tag` dispatcher over its own event union) and chained
// into the SAME `processTick` via `Effect.andThen`, mirroring the personalEvents ProcessorService's
// provision/reconcile passes.
// ---------------------------------------------------------------------------

const bankTokenExpiryAction: (
  event: FinanceRpcEvents.UnprocessedBankTokenExpiryEvent,
) => Effect.Effect<void, unknown, SyncRpc | DiscordREST> =
  Match.type<FinanceRpcEvents.UnprocessedBankTokenExpiryEvent>().pipe(
    Match.tag('bank_token_expiring', handleBankTokenExpiring),
    Match.exhaustive,
  );

const processBankTokenExpiryEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: FinanceRpcEvents.UnprocessedBankTokenExpiryEvent) =>
        bankTokenExpiryAction(event).pipe(
          Effect.flatMap(() => rpc['Finance/MarkBankTokenExpiryProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(
                Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'finance' }),
                { action: event._tag },
              ),
              1,
            ),
          ),
          Effect.catch((error) =>
            recordSyncFailure(
              rpc['Finance/MarkBankTokenExpiryFailed']({
                id: event.id,
                error: Cause.pretty(Cause.fail(error)),
              }),
              {
                syncType: 'finance',
                message: `Failed to process bank token expiry event ${event.id}`,
                error,
              },
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan(`sync/finance/${event._tag}`, {
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
  Effect.bind('processBankTokenExpiryEvent', ({ rpc, discord }) =>
    processBankTokenExpiryEvent.pipe(
      Effect.provideService(SyncRpc, rpc),
      Effect.provideService(DiscordREST, discord),
    ),
  ),
  Effect.tap(() => Effect.logInfo('FinanceSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent, processBankTokenExpiryEvent }) =>
    // ── PASS 1: payment reminders ──────────────────────────────────────────
    rpc['Finance/GetUnprocessedPaymentReminders']({ limit: POLL_BATCH_SIZE }).pipe(
      Effect.tap((events) => Effect.logDebug(`Finance sync poll: ${events.length} event(s)`)),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() => Effect.logInfo(`Processed ${events.length} finance sync event(s)`)),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling finance sync events', error)),
      // ── PASS 2: bank-token-expiry DMs ──────────────────────────────────────
      Effect.andThen(
        rpc['Finance/GetUnprocessedBankTokenExpiryEvents']({ limit: POLL_BATCH_SIZE }).pipe(
          Effect.tap((events) =>
            Effect.logDebug(`Bank token expiry poll: ${events.length} event(s)`),
          ),
          Effect.flatMap((events) =>
            events.length === 0
              ? Effect.void
              : Effect.all(Array.map(events, processBankTokenExpiryEvent), {
                  concurrency: 1,
                }).pipe(
                  Effect.tap(() =>
                    Effect.logInfo(`Processed ${events.length} bank token expiry event(s)`),
                  ),
                  Effect.asVoid,
                ),
          ),
          Effect.tapError((error) =>
            Effect.logError('Error polling bank token expiry events', error),
          ),
        ),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
  Bind.remove('processBankTokenExpiryEvent'),
);
