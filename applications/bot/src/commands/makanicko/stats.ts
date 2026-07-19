import { Discord } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const formatDuration = (minutes: number): string => {
  if (minutes === 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

export const statsHandler = Interaction.asEffect().pipe(
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
            content: m.bot_makanicko_stats_error({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const discordUserId = maybeUserId.value;

    const work = Effect.Do.pipe(
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rpc, rest }) =>
        rpc['Activity/GetStats']({
          guild_id: snowflakeGuildId,
          discord_user_id: discordUserId,
        }).pipe(
          Effect.map((stats) => {
            if (stats.total_activities === 0) {
              return {
                embeds: [
                  {
                    title: m.bot_makanicko_stats_title({}, { locale }),
                    description: m.bot_makanicko_stats_empty({}, { locale }),
                    color: 0x99aab5,
                  },
                ],
              };
            }

            const countFields = stats.counts.flatMap((c, i) => {
              const fields = [
                {
                  name: c.activity_type_name,
                  value: String(c.count),
                  inline: true,
                },
              ];
              // Add spacer after every 2 count fields to keep layout in groups of 3
              if ((i + 1) % 2 === 0) {
                fields.push({ name: '\u200b', value: '\u200b', inline: true });
              }
              return fields;
            });

            return {
              embeds: [
                {
                  title: m.bot_makanicko_stats_title({}, { locale }),
                  description: m.bot_makanicko_stats_streak(
                    { days: stats.current_streak, longest: stats.longest_streak },
                    { locale },
                  ),
                  color: 0x57f287,
                  fields: [
                    {
                      name: m.bot_makanicko_stats_total({}, { locale }),
                      value: String(stats.total_activities),
                      inline: true,
                    },
                    {
                      name: m.bot_makanicko_stats_duration({}, { locale }),
                      value: formatDuration(stats.total_duration_minutes),
                      inline: true,
                    },
                    { name: '\u200b', value: '\u200b', inline: true },
                    ...countFields,
                  ],
                  footer: { text: m.bot_makanicko_stats_footer({}, { locale }) },
                },
              ],
            };
          }),
          Effect.catchTag('ActivityGuildNotFound', () =>
            Effect.succeed({ content: m.bot_makanicko_stats_error({}, { locale }) }),
          ),
          Effect.catchTag('ActivityMemberNotFound', () =>
            Effect.succeed({ content: m.bot_makanicko_log_not_member({}, { locale }) }),
          ),
          Effect.catchTag('RpcClientError', () =>
            Effect.succeed({ content: m.bot_makanicko_stats_error({}, { locale }) }),
          ),
          Effect.flatMap((payload) =>
            rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
              payload,
            }),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
            Effect.logError('Failed to update makanicko stats response', error),
          ),
        ),
      ),
    );

    const deferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    };
    // Terminal backstop: the fork resolves the deferred reply; on any unhandled
    // failure or defect still resolve it so the user isn't stuck on "Sideline is
    // thinking…". Mirrors the profile-complete / event-create backstop.
    return Effect.as(
      Effect.forkDetach(
        work.pipe(
          Effect.catchCause((cause) =>
            Effect.logError('makanicko-stats: unexpected failure', cause).pipe(
              Effect.andThen(DiscordREST.asEffect()),
              Effect.flatMap((rest) =>
                rest
                  .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                    payload: { content: m.bot_makanicko_stats_error({}, { locale }) },
                  })
                  .pipe(
                    Effect.catchTag(
                      ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                      (e) => Effect.logError('Failed to update makanicko stats error response', e),
                    ),
                  ),
              ),
            ),
          ),
        ),
      ),
      deferred,
    );
  }),
  Effect.withSpan('command/makanicko/stats'),
);
