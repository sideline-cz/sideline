import { Discord } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, pipe } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const logHandler = Interaction.asEffect().pipe(
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
            content: m.bot_makanicko_no_guild({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const snowflakeGuildId = Discord.Snowflake.makeUnsafe(guildId);
    const maybeUserId = interactionUserId(interaction);

    if (Option.isNone(maybeUserId)) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_makanicko_log_error({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const discordUserId = maybeUserId.value;

    const data = interaction.data;
    const subCommand = data && 'options' in data ? data.options?.[0] : undefined;
    const options = subCommand && 'options' in subCommand ? [...(subCommand.options ?? [])] : [];

    const maybeActivityType = pipe(
      options,
      Array.findFirst((o) => o.name === 'activity'),
      Option.flatMap((o) => ('value' in o ? Option.some(String(o.value)) : Option.none())),
    );

    if (Option.isNone(maybeActivityType)) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_makanicko_log_error({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const activityType = maybeActivityType.value;

    const durationMinutes = pipe(
      options,
      Array.findFirst((o) => o.name === 'duration'),
      Option.flatMap((o) =>
        'value' in o && o.value !== null && o.value !== undefined
          ? Option.some(Number(o.value))
          : Option.none(),
      ),
    );

    const note = pipe(
      options,
      Array.findFirst((o) => o.name === 'note'),
      Option.flatMap((o) =>
        'value' in o && o.value !== null && o.value !== undefined
          ? Option.some(String(o.value))
          : Option.none(),
      ),
    );

    const loggedAtDate = pipe(
      options,
      Array.findFirst((o) => o.name === 'date'),
      Option.flatMap((o) =>
        'value' in o && o.value !== null && o.value !== undefined
          ? Option.some(String(o.value))
          : Option.none(),
      ),
      Option.flatMap((s) => (s === '' ? Option.none<string>() : Option.some(s))),
    );

    const work = Effect.Do.pipe(
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rpc, rest }) =>
        rpc['Activity/LogActivity']({
          guild_id: snowflakeGuildId,
          discord_user_id: discordUserId,
          activity_type: activityType,
          duration_minutes: durationMinutes,
          note,
          logged_at_date: loggedAtDate,
        }).pipe(
          Effect.map((result) => ({
            content: m.bot_makanicko_log_success({ activity: result.activity_type_id }, { locale }),
          })),
          Effect.catchTag('ActivityGuildNotFound', () =>
            Effect.succeed({ content: m.bot_makanicko_log_error({}, { locale }) }),
          ),
          Effect.catchTag('ActivityMemberNotFound', () =>
            Effect.succeed({ content: m.bot_makanicko_log_not_member({}, { locale }) }),
          ),
          Effect.catchTag('ActivityTypeNotFound', () =>
            Effect.succeed({ content: m.bot_makanicko_log_error({}, { locale }) }),
          ),
          Effect.catchTag('ActivityLogInvalidLoggedAtDate', () =>
            Effect.succeed({ content: m.bot_makanicko_log_invalid_date({}, { locale }) }),
          ),
          Effect.catchTag('RpcClientError', () =>
            Effect.succeed({ content: m.bot_makanicko_log_error({}, { locale }) }),
          ),
          Effect.flatMap((payload) =>
            rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
              payload,
            }),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
            Effect.logError('Failed to update makanicko log response', error),
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
  Effect.withSpan('command/makanicko/log'),
);
