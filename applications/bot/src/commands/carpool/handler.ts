import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildCarpoolEmbed } from '~/rest/carpool/buildCarpoolEmbed.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

export const carpoolHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;
    const channelId = interaction.channel_id;

    if (guildId === undefined || channelId === undefined) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_carpool_no_guild({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const discordUserId = decodeSnowflake(
      interaction.member?.user?.id ?? interaction.user?.id ?? '',
    );

    const work = Effect.Do.pipe(
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rpc, rest }) =>
        rpc['Carpool/CreateCarpool']({
          guild_id: decodeSnowflake(guildId),
          discord_user_id: discordUserId,
          discord_channel_id: decodeSnowflake(channelId),
          event_id: Option.none(),
        }).pipe(
          Effect.flatMap((view) => {
            const { embeds, components } = buildCarpoolEmbed(view);
            return rest
              .createMessage(decodeSnowflake(channelId), {
                embeds,
                components,
                allowed_mentions: { parse: [] },
              })
              .pipe(
                Effect.flatMap((msg) =>
                  rpc['Carpool/SaveCarpoolMessageId']({
                    carpool_id: view.carpool_id,
                    discord_message_id: decodeSnowflake(msg.id),
                  }),
                ),
              );
          }),
          Effect.flatMap(() =>
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: { content: m.bot_carpool_created({}, { locale }) },
              })
              .pipe(
                Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
                  Effect.logError('Failed to update carpool response', e),
                ),
              ),
          ),
          Effect.catchTag('CarpoolForbidden', () =>
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: { content: m.bot_carpool_no_permission({}, { locale }) },
              })
              .pipe(
                Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
                  Effect.logError('Failed to update carpool response', e),
                ),
              ),
          ),
          Effect.catchTag('CarpoolGuildNotFound', () =>
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: { content: m.bot_carpool_no_guild({}, { locale }) },
              })
              .pipe(
                Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
                  Effect.logError('Failed to update carpool response', e),
                ),
              ),
          ),
          Effect.catchTag('CarpoolNotMember', () =>
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: { content: m.bot_carpool_err_not_member({}, { locale }) },
              })
              .pipe(
                Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
                  Effect.logError('Failed to update carpool response', e),
                ),
              ),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
            Effect.logError('Failed to create carpool message', error).pipe(
              Effect.flatMap(() =>
                rest
                  .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                    payload: { content: m.bot_carpool_err_generic({}, { locale }) },
                  })
                  .pipe(
                    Effect.catchTag(
                      ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                      (e) => Effect.logError('Failed to update carpool error response', e),
                    ),
                  ),
              ),
            ),
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
  Effect.withSpan('command/carpool'),
);
