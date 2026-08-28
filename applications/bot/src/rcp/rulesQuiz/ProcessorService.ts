import type { RulesQuizRpcGroup } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Metric } from 'effect';
import { syncEventsProcessedTotal } from '~/metrics.js';
import { POLL_BATCH_SIZE } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { recordSyncFailure } from '../recordSyncFailure.js';
import { handleQuizDue } from './handleQuizDue.js';

/**
 * Drains the scheduled-quiz outbox. One event = one situation posted to one
 * team's channel, with a public thread opened on it.
 *
 * `MarkFailed` leaves the row unprocessed, so a Discord outage retries on the
 * next poll rather than silently costing a team its quiz. The server's
 * `UNIQUE (team_id, scheduled_for)` is what keeps that retry from becoming a
 * duplicate post if a failure happened AFTER the message went out.
 *
 * The locale is resolved by `handleQuizDue` from the guild's own
 * `preferred_locale`, which is what every other permanent guild-visible
 * message uses. It used to be hardcoded to English here, so a Czech team got
 * a Czech situation wrapped in English chrome on every scheduled post.
 */
const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: RulesQuizRpcGroup.RulesQuizPendingEvent) =>
        handleQuizDue(event).pipe(
          Effect.flatMap(() => rpc['RulesQuiz/MarkProcessed']({ id: event.id })),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(syncEventsProcessedTotal, { sync_type: 'rules_quiz' }),
              1,
            ),
          ),
          Effect.catch((error) =>
            recordSyncFailure(rpc['RulesQuiz/MarkFailed']({ id: event.id, error: String(error) }), {
              syncType: 'rules_quiz',
              message: `Failed to post scheduled rules quiz ${event.id}`,
              error,
            }),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan('sync/rulesQuiz/post', {
            attributes: { 'event.id': event.id },
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
  Effect.map(({ rpc, processEvent: process }) => ({
    processTick: rpc['RulesQuiz/PendingEvents']({ limit: POLL_BATCH_SIZE }).pipe(
      Effect.flatMap((events) => Effect.forEach(events, process, { concurrency: 1 })),
      Effect.asVoid,
    ),
  })),
);
