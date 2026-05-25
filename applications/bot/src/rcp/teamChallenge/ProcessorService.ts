import type { TeamChallengeSyncEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Metric } from 'effect';
import { env } from '../../env.js';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { handleTeamChallengeReady } from './handleTeamChallengeReady.js';

// Structural narrowing helper — avoids an `as` cast.
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Converts an unknown error from the Discord REST layer into a loggable string.
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
      (event: TeamChallengeSyncEvents.UnprocessedTeamChallengeEvent) => {
        return handleTeamChallengeReady(event, env.WEB_URL).pipe(
          Effect.flatMap(() =>
            rpc['TeamChallenge/MarkTeamChallengeProcessed']({
              eventId: event.id,
              deliveredAt: DateTime.nowUnsafe(),
            }),
          ),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(syncEventsProcessedTotal, {
                sync_type: 'team_challenge',
              }),
              1,
            ),
          ),
          Effect.catch((error) =>
            rpc['TeamChallenge/MarkTeamChallengeFailed']({
              eventId: event.id,
              error: formatError(error),
            }).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Failed to process team challenge sync event ${event.id}`, error),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, {
                    sync_type: 'team_challenge',
                  }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan('sync/team_challenge/ready', {
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
  Effect.tap(() => Effect.logInfo('TeamChallengeSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    rpc['TeamChallenge/GetUnprocessedTeamChallengeEvents']().pipe(
      Effect.tap((events) =>
        Effect.logDebug(`Team challenge sync poll: ${events.length} event(s)`),
      ),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(`Processed ${events.length} team challenge sync event(s)`),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) =>
        Effect.logError('Error polling team challenge sync events', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
