import type { WeeklyChallengeSyncEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Metric } from 'effect';
import { env } from '../../env.js';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { handleWeeklyChallengeReady } from './handleWeeklyChallengeReady.js';

// Structural narrowing helper — same pattern as errorClassifier.ts across the
// bot codebase. Avoids an `as` cast: TypeScript narrows to `object` first, then
// property access via the typed helper is safe.
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Converts an unknown error from the Discord REST layer into a loggable string.
// Extracts structured fields (_tag, response.status, code) when present so
// operators can correlate errors to specific Discord API failure modes.
//
// Check order:
//   1. string  → return as-is
//   2. Error   → name + message (+ cause). JSON.stringify(new Error) returns '{}'
//                because Error.message/stack are non-enumerable — avoid it.
//   3. tagged object with response.status (ErrorResponse) → structured path
//   4. tagged object (other Effect error) → tag + JSON
//   5. fallback → String()
const formatError = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    const cause = err.cause !== undefined ? ` (caused by: ${String(err.cause)})` : '';
    return `${err.name}: ${err.message}${cause}`;
  }
  if (isRec(err)) {
    const tag = typeof err._tag === 'string' ? err._tag : 'Error';
    const resp = err.response;
    const code = err.code;
    if (isRec(resp)) {
      const codeStr = code !== undefined ? ` code=${String(code)}` : '';
      return `${tag}: status=${String(resp.status)}${codeStr}`;
    }
    return `${tag}: ${JSON.stringify(err)}`;
  }
  return String(err);
};

const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent) => {
        // NOTE: UnprocessedWeeklyChallengeEvent is a plain Schema.Class (no _tag).
        // Single event type — no Match.tag dispatch. Call the handler directly.
        return handleWeeklyChallengeReady(event, env.WEB_URL).pipe(
          Effect.flatMap(() =>
            rpc['WeeklyChallenge/MarkWeeklyChallengeProcessed']({
              eventId: event.id,
              deliveredAt: DateTime.nowUnsafe(),
            }),
          ),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(syncEventsProcessedTotal, {
                sync_type: 'weekly_challenge',
              }),
              1,
            ),
          ),
          Effect.catch((error) =>
            rpc['WeeklyChallenge/MarkWeeklyChallengeFailed']({
              eventId: event.id,
              error: formatError(error),
            }).pipe(
              Effect.tap(() =>
                Effect.logWarning(
                  `Failed to process weekly challenge sync event ${event.id}`,
                  error,
                ),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, {
                    sync_type: 'weekly_challenge',
                  }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan('sync/weekly_challenge/ready', {
            attributes: { 'event.id': String(event.id) },
          }),
        );
      },
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
  Effect.tap(() => Effect.logInfo('WeeklyChallengeSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    // NOTE: server-side query is currently unbounded (no LIMIT). Acceptable
    // because at most one challenge per team per week bounds the backlog.
    // Follow-up: add LIMIT in Part 1 follow-up; bot adds no client-side cap.
    rpc['WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents']().pipe(
      Effect.tap((events) =>
        Effect.logDebug(`Weekly challenge sync poll: ${events.length} event(s)`),
      ),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${events.length} weekly challenge sync event(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) =>
        Effect.logError('Error polling weekly challenge sync events', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
