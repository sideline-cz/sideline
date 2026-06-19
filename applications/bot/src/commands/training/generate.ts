import { Discord } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, pipe } from 'effect';
import { env } from '~/env.js';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildTrainingGenerateDeepLink } from '~/rest/email/buildEmailEmbeds.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const generateHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;

    if (!guildId) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_training_generate_no_guild({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const maybeUserId = interactionUserId(interaction);
    if (Option.isNone(maybeUserId)) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_training_generate_not_member({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const snowflakeGuildId = Discord.Snowflake.makeUnsafe(guildId);

    const data = interaction.data;
    const subCommand = data && 'options' in data ? data.options?.[0] : undefined;
    const options = subCommand && 'options' in subCommand ? [...(subCommand.options ?? [])] : [];

    const maybeEventId = pipe(
      options,
      Array.findFirst((o) => o.name === 'event'),
      Option.flatMap((o) => ('value' in o ? Option.some(String(o.value)) : Option.none())),
    );

    if (Option.isNone(maybeEventId)) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_training_generate_not_loggable({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const eventId = maybeEventId.value;

    const work = Effect.Do.pipe(
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rpc, rest }) =>
        Effect.all(
          {
            loggable: rpc['Event/GetLoggableTrainingEvents']({ guild_id: snowflakeGuildId }),
            upcoming: rpc['Event/GetUpcomingGuildEvents']({
              guild_id: snowflakeGuildId,
              offset: 0,
              limit: 0,
            }),
          },
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.flatMap(({ loggable, upcoming }) => {
            const teamId = upcoming.team_id;

            const maybeEvent = pipe(
              [...loggable],
              Array.findFirst((e) => e.event_id === eventId),
            );

            const payload = Option.match(maybeEvent, {
              onNone: () => ({
                content: m.bot_training_generate_not_loggable({}, { locale }),
                allowed_mentions: { parse: [] as const },
              }),
              onSome: (event) => {
                const deepLink = buildTrainingGenerateDeepLink(env.WEB_URL, teamId, event.event_id);
                return Option.match(deepLink, {
                  onNone: () => ({
                    content: m.bot_training_generate_deeplink_no_url({}, { locale }),
                    allowed_mentions: { parse: [] as const },
                  }),
                  onSome: (url) => ({
                    content: m.bot_training_generate_deeplink_message(
                      {
                        link: `[${m.bot_training_generate_deeplink_label({ event: event.title }, { locale })}](${url})`,
                      },
                      { locale },
                    ),
                    allowed_mentions: { parse: [] as const },
                  }),
                });
              },
            });

            return rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload,
              })
              .pipe(Effect.asVoid);
          }),
          Effect.tapError((error) =>
            Effect.logWarning('training/generate: RPC or upstream error', error),
          ),
          Effect.catchTag('GuildNotFound', () =>
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: {
                  content: m.bot_training_generate_not_member({}, { locale }),
                  allowed_mentions: { parse: [] as const },
                },
              })
              .pipe(Effect.asVoid),
          ),
          Effect.catchTag('RpcClientError', () =>
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: {
                  content: m.bot_training_generate_error({}, { locale }),
                  allowed_mentions: { parse: [] as const },
                },
              })
              .pipe(Effect.asVoid),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
            Effect.logError('Failed to update training generate response', error),
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
  Effect.withSpan('command/training/generate'),
);
