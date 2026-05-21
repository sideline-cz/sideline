import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, pipe } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';

const THREAD_CHANNEL_TYPES = new Set<number>([
  DiscordTypes.ChannelTypes.PUBLIC_THREAD,
  DiscordTypes.ChannelTypes.PRIVATE_THREAD,
  DiscordTypes.ChannelTypes.ANNOUNCEMENT_THREAD,
]);

const ephemeral = (content: string) =>
  Ix.response({
    type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: DiscordTypes.MessageFlags.Ephemeral,
    },
  });

const numberProp = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
};

const isDiscordPermissionError = (error: unknown): boolean => {
  if (error === null || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const httpStatus = numberProp(record, 'status');
  if (httpStatus === 403 || httpStatus === 404) return true;
  const discordCode = numberProp(record, 'code');
  return discordCode === 50013;
};

export const joinHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const channelId = interaction.channel_id;
    const channelType = interaction.channel?.type;

    if (channelId === undefined || channelType === undefined) {
      return Effect.succeed(ephemeral(m.bot_join_not_thread({}, { locale })));
    }
    if (!THREAD_CHANNEL_TYPES.has(channelType)) {
      return Effect.succeed(ephemeral(m.bot_join_not_thread({}, { locale })));
    }

    const data = interaction.data;
    const options = data && 'options' in data ? [...(data.options ?? [])] : [];

    const maybeUserId = pipe(
      options,
      Array.findFirst((o) => o.name === 'user'),
      Option.flatMap((o) =>
        'value' in o && o.value !== null && o.value !== undefined
          ? Option.some(String(o.value))
          : Option.none(),
      ),
    );

    if (Option.isNone(maybeUserId)) {
      return Effect.succeed(ephemeral(m.bot_join_missing_user({}, { locale })));
    }

    const userId = maybeUserId.value;

    const work = DiscordREST.asEffect().pipe(
      Effect.flatMap((rest) =>
        rest.addThreadMember(channelId, userId).pipe(
          Effect.map(() => ({ content: m.bot_join_success({ userId }, { locale }) })),
          Effect.catchTag('ErrorResponse', (error) =>
            Effect.succeed({
              content: isDiscordPermissionError(error)
                ? m.bot_join_bot_forbidden({}, { locale })
                : m.bot_join_error({}, { locale }),
            }),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse'], (error) =>
            Effect.logWarning('Failed to add thread member', error).pipe(
              Effect.as({ content: m.bot_join_error({}, { locale }) }),
            ),
          ),
          Effect.flatMap((payload) =>
            rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
              payload: {
                ...payload,
                allowed_mentions: { parse: [] },
              },
            }),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
            Effect.logError('Failed to update join response', error),
          ),
        ),
      ),
    );

    const deferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    };
    return Effect.as(Effect.forkDetach(work), deferred);
  }),
  Effect.withSpan('command/join'),
);
