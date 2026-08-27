import { RulesQuizRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Effect } from 'effect';
import { RulesQuizSyncEventsRepository } from '~/repositories/RulesQuizSyncEventsRepository.js';

/**
 * Serves the scheduled-quiz outbox to the bot. A thin pass-through to
 * `RulesQuizSyncEventsRepository` — the scheduling lives in `RulesQuizCron`
 * and the rendering lives in the bot, so there is deliberately no logic here.
 */
export const RulesQuizRpcLive = Effect.Do.pipe(
  Effect.bind('events', () => RulesQuizSyncEventsRepository.asEffect()),
  Effect.let(
    'RulesQuiz/PendingEvents',
    ({ events }) =>
      ({ limit }: { readonly limit: number }) =>
        events.findUnprocessed(limit),
  ),
  Effect.let(
    'RulesQuiz/MarkProcessed',
    ({ events }) =>
      ({ id }: { readonly id: string }) =>
        events.markProcessed(id),
  ),
  Effect.let(
    'RulesQuiz/MarkFailed',
    ({ events }) =>
      ({ id, error }: { readonly id: string; readonly error: string }) =>
        events.markFailed(id, error),
  ),
  Bind.remove('events'),
  (handlers) => RulesQuizRpcGroup.RulesQuizRpcGroup.toLayer(handlers),
);
