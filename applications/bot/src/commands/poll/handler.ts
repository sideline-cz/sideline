import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildPollEmbed } from '~/rest/poll/buildPollEmbed.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

/** The error union shared by every dfx DiscordREST call. */
type RestError = Effect.Error<ReturnType<DiscordRestService['updateOriginalWebhookMessage']>>;

/** Log and swallow the three Discord REST failure tags. */
const logRestErrors =
  (context: string) =>
  <A, R>(effect: Effect.Effect<A, RestError, R>) =>
    effect.pipe(
      Effect.catchTag(['ErrorResponse', 'HttpClientError', 'RatelimitedResponse'], (e) =>
        Effect.logError(context, e),
      ),
    );

/** Update the deferred webhook reply with a plain content message, swallowing REST failures. */
const replyContent = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  content: string,
  context: string,
) =>
  rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
      payload: { content },
    })
    .pipe(logRestErrors(context));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Extract a named option's 'value' field from the flat command options array. */
const getOptionValue = (options: ReadonlyArray<Record<string, unknown>>, name: string): unknown => {
  for (const o of options) {
    if (o.name === name) return o.value;
  }
  return undefined;
};

/** Parse the flat options array from a guild slash command interaction. */
const getRawOptions = (
  interaction: DiscordTypes.APIInteraction,
): ReadonlyArray<Record<string, unknown>> => {
  const d: unknown = interaction.data;
  if (!isRecord(d)) return [];
  const opts: unknown = d.options;
  if (!Array.isArray(opts)) return [];
  return opts.filter(isRecord);
};

export const pollHandler = Interaction.asEffect().pipe(
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
            content: m.bot_poll_err_no_guild({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const embedLocale = guildLocale(interaction);
    const discordUserIdOption = interactionUserId(interaction);

    if (Option.isNone(discordUserIdOption)) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_poll_err_no_guild({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const discordUserId = discordUserIdOption.value;

    // Extract flat command options from interaction data
    const rawOptions = getRawOptions(interaction);

    const question = String(getOptionValue(rawOptions, 'question') ?? '');
    const optionsRaw = String(getOptionValue(rawOptions, 'options') ?? '');
    const multiple = Boolean(getOptionValue(rawOptions, 'multiple') ?? false);
    const deadlineRaw = getOptionValue(rawOptions, 'deadline');
    const allowedRoleId = getOptionValue(rawOptions, 'allowed_role');

    const work = Effect.Do.pipe(
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rpc, rest }) =>
        rpc['Poll/CreatePoll']({
          guild_id: decodeSnowflake(guildId),
          discord_user_id: discordUserId,
          discord_channel_id: decodeSnowflake(channelId),
          question,
          options_raw: optionsRaw,
          multiple,
          allowed_role_id:
            typeof allowedRoleId === 'string' && allowedRoleId.length > 0
              ? Option.some(decodeSnowflake(allowedRoleId))
              : Option.none(),
          deadline_raw:
            typeof deadlineRaw === 'string' && deadlineRaw.length > 0
              ? Option.some(deadlineRaw)
              : Option.none(),
        }).pipe(
          Effect.flatMap((view) => {
            const { embeds, components } = buildPollEmbed(view, embedLocale);
            return rest
              .createMessage(decodeSnowflake(channelId), {
                embeds,
                components,
                allowed_mentions: { parse: [] },
              })
              .pipe(
                Effect.flatMap((msg) =>
                  rpc['Poll/SavePollMessageId']({
                    poll_id: view.poll_id,
                    discord_message_id: decodeSnowflake(msg.id),
                  }),
                ),
              );
          }),
          Effect.flatMap(() =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_created({}, { locale }),
              'Failed to update poll response',
            ),
          ),
          Effect.catchTag('PollForbidden', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_not_captain({}, { locale }),
              'Failed to update poll forbidden response',
            ),
          ),
          Effect.catchTag('PollGuildNotFound', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_no_guild({}, { locale }),
              'Failed to update poll guild-not-found response',
            ),
          ),
          Effect.catchTag('PollNotMember', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_not_member({}, { locale }),
              'Failed to update poll not-member response',
            ),
          ),
          Effect.catchTag('PollTooFewOptions', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_option_count({}, { locale }),
              'Failed to update poll option-count response',
            ),
          ),
          Effect.catchTag('PollTooManyOptions', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_option_count({}, { locale }),
              'Failed to update poll too-many response',
            ),
          ),
          Effect.catchTag('PollDuplicateOption', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_option_duplicate({}, { locale }),
              'Failed to update poll duplicate response',
            ),
          ),
          Effect.catchTag('PollOptionTooLong', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_option_length({}, { locale }),
              'Failed to update poll option-length response',
            ),
          ),
          Effect.catchTag('PollInvalidDeadline', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_deadline_format({}, { locale }),
              'Failed to update poll invalid-deadline response',
            ),
          ),
          Effect.catchTag('PollDeadlineInPast', () =>
            replyContent(
              rest,
              interaction,
              m.bot_poll_err_deadline_past({}, { locale }),
              'Failed to update poll deadline-past response',
            ),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
            Effect.logError('Failed to create poll message', error).pipe(
              Effect.flatMap(() =>
                replyContent(
                  rest,
                  interaction,
                  m.bot_poll_err_generic({}, { locale }),
                  'Failed to update poll error response',
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
  Effect.withSpan('command/poll'),
);
