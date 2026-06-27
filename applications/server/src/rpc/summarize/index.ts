import { SummarizeRpcGroup, SummarizeRpcModels } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DateTime, Effect, Option } from 'effect';
import { LlmClient } from '~/services/LlmClient.js';

export const SummarizeRpcLive = Effect.Do.pipe(
  Effect.bind('llm', () => LlmClient.asEffect()),
  Effect.let(
    'Summarize/SummarizeChannel',
    ({ llm }) =>
      (input: SummarizeRpcModels.SummarizeChannelInput) =>
        llm
          .summarizeChannel({
            messages: input.messages.map((m) => ({
              author: m.author,
              content: m.content,
              timestamp: DateTime.formatIso(m.timestamp),
            })),
            channelName: Option.getOrUndefined(input.channelName),
            locale: input.locale,
          })
          .pipe(
            Effect.map(
              ({ summary, generated, summarizedCount }) =>
                new SummarizeRpcModels.SummarizeChannelResult({
                  summary,
                  generated,
                  summarizedCount,
                }),
            ),
          ),
  ),
  Bind.remove('llm'),
  (handlers) => SummarizeRpcGroup.SummarizeRpcGroup.toLayer(handlers),
);
