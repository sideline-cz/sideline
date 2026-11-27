/**
 * Routing for messages posted in `/assistant` threads. The conversation is not stored anywhere
 * but Discord: every turn rebuilds the history from the thread itself and sends it to the
 * server's `Assistant/Chat`, which runs the same assistant turn the web does.
 */
import { AiChatApi, type AssistantRpcModels, Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { DiscordGateway } from 'dfx/gateway';
import * as DiscordTypes from 'dfx/types';
import { Effect, Schedule, Schema } from 'effect';
import type { Locale } from '~/locale.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { buildHistory, buildProposalMessage, splitMessage } from './render.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

// How far back a turn reads the thread. The server keeps at most 20 turns anyway.
const HISTORY_FETCH_LIMIT = 50;

// ponytail: process-local cache, one entry per channel that ever saw a message. A channel's
// answer never changes (a thread is registered once, before anyone can post in it), so no
// eviction; a restart just re-asks the server once per channel.
const owners = new Map<string, AssistantRpcModels.AssistantThreadOwner | null>();

/** `null` = the channel is not an assistant thread. */
export const threadOwner = (channelId: string) =>
  Effect.suspend(() => {
    const cached = owners.get(channelId);
    if (cached !== undefined) return Effect.succeed(cached);
    return SyncRpc.asEffect().pipe(
      Effect.flatMap((rpc) =>
        rpc['Assistant/GetThreadOwner']({ thread_id: decodeSnowflake(channelId) }),
      ),
      Effect.tap((owner) => Effect.sync(() => owners.set(channelId, owner))),
    );
  });

const degradedText: Record<AiChatApi.DegradedReason, (l: Locale) => string> = {
  not_configured: (locale) => m.assistant_degraded_notConfigured({}, { locale }),
  disabled: (locale) => m.assistant_degraded_disabled({}, { locale }),
  provider_error: (locale) => m.assistant_degraded_providerError({}, { locale }),
  too_many_steps: (locale) => m.assistant_degraded_tooManySteps({}, { locale }),
  empty_answer: (locale) => m.assistant_degraded_emptyAnswer({}, { locale }),
};

export interface IncomingMessage {
  readonly channel_id: string;
  readonly guild_id?: string | null | undefined;
  readonly author: { readonly id: string; readonly bot?: boolean | null | undefined };
  readonly content: string;
}

const runTurn = (message: IncomingMessage, owner: AssistantRpcModels.AssistantThreadOwner) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.flatMap(({ rest, rpc }) => {
      const locale = owner.locale;
      const channelId = message.channel_id;
      const send = (content: string) =>
        rest.createMessage(channelId, { content, allowed_mentions: { parse: [] } });

      const reply = (result: AssistantRpcModels.AssistantTurn) =>
        Effect.forEach(
          splitMessage(
            result.degraded_reason === null
              ? result.answer
              : degradedText[result.degraded_reason](locale),
          ),
          send,
          { discard: true },
        ).pipe(
          Effect.andThen(
            result.proposal === null
              ? Effect.void
              : rest.createMessage(channelId, {
                  ...buildProposalMessage(result.proposal, locale),
                  allowed_mentions: { parse: [] },
                }),
          ),
        );

      const turn = rest.listMessages(channelId, { limit: HISTORY_FETCH_LIMIT }).pipe(
        Effect.map((page) => buildHistory(page, owner.owner_discord_id)),
        Effect.flatMap((history) =>
          history.length === 0
            ? Effect.void
            : rpc['Assistant/Chat']({
                thread_id: decodeSnowflake(channelId),
                discord_user_id: decodeSnowflake(message.author.id),
                messages: history.map((t) => new AiChatApi.ChatMessage(t)),
              }).pipe(Effect.flatMap(reply)),
        ),
        Effect.catchTag('AiChatRateLimited', (e) =>
          send(
            `${m.assistant_turnFailedRateLimited({}, { locale })} ${m.assistant_turnFailedRetryIn(
              { seconds: e.retryAfterSeconds },
              { locale },
            )}`,
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logError('Assistant turn failed', cause).pipe(
            Effect.andThen(send(m.bot_assistant_error({}, { locale }))),
            Effect.ignore,
          ),
        ),
      );

      // The indicator lasts ~10 s; keep it alive until the reply is posted. `turn` never fails,
      // so the race ends exactly when it does.
      const typing = rest
        .triggerTypingIndicator(channelId)
        .pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced('8 seconds')),
          Effect.andThen(Effect.never),
        );
      return Effect.race(turn, typing);
    }),
  );

const isCandidate = (message: IncomingMessage): boolean =>
  message.guild_id != null && message.author.bot !== true && message.content.trim() !== '';

/**
 * Handle one `MESSAGE_CREATE`. Ignored unless it is the thread owner's own message in an
 * assistant thread — in a public thread, anyone else's message is ignored silently.
 */
export const handleAssistantMessage = (message: IncomingMessage) =>
  (isCandidate(message)
    ? threadOwner(message.channel_id).pipe(
        Effect.flatMap((owner) =>
          owner === null || owner.owner_discord_id !== message.author.id
            ? Effect.void
            : runTurn(message, owner),
        ),
      )
    : Effect.void
  ).pipe(
    Effect.catchCause((cause) => Effect.logError('Assistant message handler failed', cause)),
    Effect.withSpan('discord/assistant_message'),
  );

/** The `MESSAGE_CREATE` subscription. Needs the GuildMessages + MessageContent intents (env.ts). */
export const assistantMessages = DiscordGateway.asEffect().pipe(
  Effect.flatMap((gateway) =>
    gateway.handleDispatch(
      DiscordTypes.GatewayDispatchEvents.MessageCreate,
      handleAssistantMessage,
    ),
  ),
);
