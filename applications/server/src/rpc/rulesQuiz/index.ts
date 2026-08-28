import { RulesQuizRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Array, Effect } from 'effect';
import { RulesQuizSyncEventsRepository } from '~/repositories/RulesQuizSyncEventsRepository.js';

/**
 * Serves the scheduled-quiz outbox to the bot. A thin pass-through to
 * `RulesQuizSyncEventsRepository` — the scheduling lives in `RulesQuizCron`
 * and the rendering lives in the bot, so there is deliberately no logic here.
 */
export const RulesQuizRpcLive = Effect.Do.pipe(
  Effect.bind('events', () => RulesQuizSyncEventsRepository.asEffect()),
  /**
   * The rows are mapped into `RulesQuizPendingEvent` rather than returned
   * as-is, even though the two carry identical fields.
   *
   * `Schema.Class` is **nominal**: encoding a `RulesQuizSyncEventRow` against
   * a `RulesQuizPendingEvent` schema fails with "Expected
   * RulesQuizPendingEvent, got RulesQuizSyncEventRow" no matter how well the
   * shapes line up. Passing the row straight through type-checked, because
   * structurally it satisfies the handler's signature — the mismatch only
   * exists at encode time, which is why nothing caught it until an event
   * actually existed to encode.
   */
  Effect.let(
    'RulesQuiz/PendingEvents',
    ({ events }) =>
      ({ limit }: { readonly limit: number }) =>
        events
          .findUnprocessed(limit)
          .pipe(
            Effect.map(Array.map((row) => new RulesQuizRpcGroup.RulesQuizPendingEvent({ ...row }))),
          ),
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
