import { DiscordReadRequest, type DiscordReadRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageResponse } from 'dfx/DiscordREST/Generated';
import { Array, Effect, type ServiceMap } from 'effect';
import { toDiscordError } from '~/rest/discordErrors.js';
import { DISCORD_TIMESTAMP_TOKEN } from '~/rest/discordTimestamp.js';
import { fetchChannelMessages, newestInWindow } from '~/rest/messages/fetchChannelMessages.js';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

// Live channel reads for the AI assistant. An AI chat turn waits on the result (15 s budget on
// the server), which is why this runs on `fastPollLoop` (bot AGENTS.md "Poll-Loop Cadences").
// Never log message content: only ids and Discord error causes.

type Result = DiscordReadRequest.DiscordReadResult;
type Message = DiscordReadRequest.DiscordReadMessage;

const fail = (outcome: Exclude<DiscordReadRequest.DiscordReadOutcome, 'ok'>): Result => ({
  outcome,
  messages: [],
  capped: false,
});

// Raw Discord ids must not reach the model through `content`. Slash-command mentions first:
// `</name:id>` would otherwise not match any later rule and keep its id.
export const resolveMentions = (
  content: string,
  mentions: ReadonlyArray<{
    readonly id: string;
    readonly username: string;
    readonly global_name?: string | null;
  }>,
): string =>
  content
    .replace(/<\/([\w -]+):\d+>/g, '/$1')
    .replace(/<@!?(\d+)>/g, (_, id: string) => {
      const user = mentions.find((u) => u.id === id);
      return user === undefined ? '@someone' : `@${user.global_name ?? user.username}`;
    })
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(DISCORD_TIMESTAMP_TOKEN, '<time>')
    .replace(
      /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/\d+\/\d+(?:\/\d+)?/g,
      '[Discord link]',
    );

const size = (messages: ReadonlyArray<Message>) => JSON.stringify(messages).length;

// Data minimisation: Postgres never holds more member content than the model gets. Keep the
// newest messages that fit READ_RESULT_CHAR_BUDGET; if the newest alone does not fit, cut its
// content and end it with an ellipsis.
export const fitToBudget = (
  messages: ReadonlyArray<Message>,
): { messages: Array<Message>; dropped: boolean } => {
  const budget = DiscordReadRequest.READ_RESULT_CHAR_BUDGET;
  // The JSON of an array is "[" + elements joined by "," + "]", so sizes add up one by one.
  let used = 1;
  let kept = 0;
  for (const message of [...messages].reverse()) {
    used += 1 + JSON.stringify(message).length;
    if (used > budget) break;
    kept += 1;
  }
  if (kept > 0) {
    return { messages: messages.slice(-kept), dropped: kept < messages.length };
  }
  const newest = messages.at(-1);
  if (newest === undefined) return { messages: [], dropped: false };
  const withContent = (content: string) => [{ ...newest, content: `${content}…` }];
  let content = newest.content;
  while (content.length > 0 && size(withContent(content)) > budget) {
    content = content.slice(0, -Math.max(1, size(withContent(content)) - budget));
  }
  return { messages: withContent(content), dropped: true };
};

const toMessage = (m: MessageResponse): Message => ({
  author: m.author.global_name ?? m.author.username,
  content: resolveMentions(m.content, m.mentions),
  timestamp: m.timestamp,
});

const read = (
  discord: ServiceMap.Service.Shape<typeof DiscordREST>,
  request: DiscordReadRpcGroup.PendingDiscordRead,
): Effect.Effect<Result> =>
  fetchChannelMessages(discord, request.channel_id, {
    cutoff: request.since,
    limit: request.limit,
  }).pipe(
    Effect.map(({ messages, capped, exhausted }): Result => {
      // Empty content is kept: the server tells the model it means attachments or embeds only.
      const human = messages.filter((m) => !m.author.bot);
      const window = newestInWindow(human, request.since, request.limit);
      const fitted = fitToBudget(window.chronological.map(toMessage));
      return {
        outcome: 'ok',
        messages: fitted.messages,
        capped:
          capped ||
          window.capped ||
          // Paging stopped on the raw count, and bot messages ate the window.
          (!exhausted && human.length < request.limit) ||
          fitted.dropped,
      };
    }),
    Effect.mapError(toDiscordError),
    Effect.catchTag('DiscordPermissionError', () => Effect.succeed(fail('no_access'))),
    Effect.catchTag('DiscordNotFoundError', () => Effect.succeed(fail('channel_missing'))),
    Effect.catchTag(['DiscordPermanentError', 'DiscordTransientError'], (e) =>
      Effect.logWarning(`Discord read failed for request ${request.id}`, e.cause).pipe(
        Effect.as(fail('discord_error')),
      ),
    ),
  );

const makeProcessRequest =
  (rpc: SyncRpcClient, discord: ServiceMap.Service.Shape<typeof DiscordREST>) =>
  (request: DiscordReadRpcGroup.PendingDiscordRead): Effect.Effect<void> =>
    read(discord, request).pipe(
      Effect.flatMap((result) => rpc['DiscordRead/SubmitResult']({ id: request.id, result })),
      // The row stays unprocessed: the next tick reads Discord again and submits again.
      Effect.catchTag('RpcClientError', (e) =>
        Effect.logError(`DiscordRead SubmitResult failed for request ${request.id}`, e),
      ),
      Effect.withSpan('sync/discord_read', {
        attributes: { 'request.id': request.id, 'channel.id': request.channel_id },
      }),
    );

export const ProcessorService = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.let('processRequest', ({ rpc, discord }) => makeProcessRequest(rpc, discord)),
  Effect.tap(() => Effect.logInfo('DiscordReadSyncService initialized')),
  Effect.let('processTick', ({ rpc, processRequest }) =>
    rpc['DiscordRead/GetUnprocessedRequests']({ limit: 5 }).pipe(
      Effect.flatMap((requests) =>
        Effect.all(Array.map(requests, processRequest), { concurrency: 1 }),
      ),
      Effect.asVoid,
      Effect.tapError((error) => Effect.logError('Error polling Discord read requests', error)),
      Effect.catchTag('RpcClientError', (error) =>
        Effect.logError('Unhandled error in Discord read poll', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('discord'),
  Bind.remove('processRequest'),
);
