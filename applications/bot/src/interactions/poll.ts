import { Discord as DiscordSchemas, Poll, type PollRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildPollEmbed } from '~/rest/poll/buildPollEmbed.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringProp = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' ? v : undefined;
};

/** Extract custom_id from interaction data. */
const getCustomId = (interaction: DiscordTypes.APIInteraction): string =>
  stringProp(interaction.data, 'custom_id') ?? '';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodePollId = Schema.decodeUnknownSync(Poll.PollId);
const decodePollOptionId = Schema.decodeUnknownSync(Poll.PollOptionId);

const ephemeralDeferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
  type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  data: { flags: DiscordTypes.MessageFlags.Ephemeral },
};

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

type WebhookUpdatePayload = Parameters<
  DiscordRestService['updateOriginalWebhookMessage']
>[2]['payload'];

/** Update the deferred ephemeral webhook reply, swallowing REST failures. */
const replyWebhook = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  payload: WebhookUpdatePayload,
  context = 'webhook update',
) =>
  rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, { payload })
    .pipe(logRestErrors(context));

/** Rebuild a poll board message at an explicit channel/message, swallowing REST failures. */
const rebuildBoardMessage = (
  rest: DiscordRestService,
  channelId: DiscordSchemas.Snowflake,
  messageId: DiscordSchemas.Snowflake,
  view: PollRpcModels.PollView,
  embedLocale: Locale,
) => {
  const { embeds, components } = buildPollEmbed(view, embedLocale);
  return rest
    .updateMessage(channelId, messageId, { embeds, components, allowed_mentions: { parse: [] } })
    .pipe(Effect.asVoid, logRestErrors('Failed to rebuild poll embed'));
};

/** Rebuild the public poll board using the channel/message id stored on the view. */
const rebuildBoard = (
  rest: DiscordRestService,
  view: PollRpcModels.PollView,
  embedLocale: Locale,
) =>
  Option.match(view.discord_message_id, {
    onNone: () => Effect.logWarning('Poll board message id not set — skipping board update'),
    onSome: (boardMessageId) =>
      rebuildBoardMessage(rest, view.discord_channel_id, boardMessageId, view, embedLocale),
  });

const isUnknownArray = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

/** Read modal field value from raw interaction data. */
const readModalFieldValue = (
  interaction: DiscordTypes.APIInteraction,
  fieldCustomId: string,
): string | undefined => {
  const data: unknown = interaction.data;
  if (!isRecord(data)) return undefined;
  const rows: unknown = data.components;
  if (!isUnknownArray(rows)) return undefined;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const inner: unknown = row.components;
    if (!isUnknownArray(inner)) continue;
    for (const comp of inner) {
      if (!isRecord(comp)) continue;
      if (comp.custom_id === fieldCustomId && typeof comp.value === 'string') {
        const val = comp.value;
        return val.trim().length > 0 ? val.trim() : undefined;
      }
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// poll-vote:{pollId}:{optionId} button
// ---------------------------------------------------------------------------

export const PollVoteButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ interaction, rpc, rest }) => {
    const locale = userLocale(interaction);
    const embedLocale = guildLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);
    const customId = getCustomId(interaction);

    // custom_id: poll-vote:{pollId}:{optionId}
    // pollId and optionId may contain hyphens but not colons — split on first two ':'
    const firstColon = customId.indexOf(':');
    const rest2 = customId.slice(firstColon + 1);
    const secondColon = rest2.indexOf(':');
    const pollIdRaw = rest2.slice(0, secondColon);
    const optionIdRaw = rest2.slice(secondColon + 1);

    // Guard: DM-context interactions have no guild_id — return ephemeral error immediately.
    if (guildId === undefined) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_poll_err_no_guild({}, { locale }) },
            'Failed to update poll vote no-guild response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_poll_err_not_member({}, { locale }) },
            'Failed to update poll vote no-user response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;
    const pollId = decodePollId(pollIdRaw);
    const optionId = decodePollOptionId(optionIdRaw);

    const voteAndFollowUp = rpc['Poll/CastVote']({
      guild_id: decodeSnowflake(guildId),
      discord_user_id: discordUserId,
      poll_id: pollId,
      option_id: optionId,
    }).pipe(
      Effect.flatMap((result) => {
        const voteMessage = (() => {
          switch (result.action) {
            case 'counted':
              return m.bot_poll_vote_counted({}, { locale });
            case 'moved':
              return m.bot_poll_vote_moved({}, { locale });
            case 'retracted':
              return m.bot_poll_vote_retracted({}, { locale });
            case 'added':
              return m.bot_poll_vote_added({}, { locale });
            case 'removed':
              return m.bot_poll_vote_removed({}, { locale });
          }
        })();

        const rebuildEffect = rebuildBoard(rest, result.view, embedLocale);

        return rebuildEffect.pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: voteMessage },
              'Failed to update poll vote response',
            ),
          ),
        );
      }),
      Effect.catchTag('PollClosed', () =>
        // Poll was lazy-closed — fetch the current view and rebuild the board to reflect
        // the closed state, so the public message stops showing live vote buttons.
        // Lock-held-during-rebuild tradeoff is acceptable at team scale.
        rpc['Poll/GetPollView']({
          guild_id: decodeSnowflake(guildId),
          discord_user_id: discordUserId,
          poll_id: pollId,
        }).pipe(
          Effect.flatMap((viewOption) =>
            Option.match(viewOption, {
              onNone: () => Effect.void,
              onSome: (view) => rebuildBoard(rest, view, embedLocale),
            }),
          ),
          Effect.catchTag('PollGuildNotFound', () => Effect.void),
          Effect.catchTag('PollNotMember', () => Effect.void),
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_poll_closed_notice({}, { locale }) },
              'Failed to update poll closed notice',
            ),
          ),
        ),
      ),
      Effect.catchTag('PollOptionNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_option_not_found({}, { locale }) },
          'Failed to update poll option-not-found response',
        ),
      ),
      Effect.catchTag('PollNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_found({}, { locale }) },
          'Failed to update poll not-found response',
        ),
      ),
      Effect.catchTag('PollNotMember', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_member({}, { locale }) },
          'Failed to update poll not-member response',
        ),
      ),
      Effect.catchTag('PollGuildNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_no_guild({}, { locale }) },
          'Failed to update poll guild-not-found response',
        ),
      ),
    );

    return Effect.as(Effect.forkDetach(voteAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/poll-vote-button'),
);

export const PollVoteButtonReg = Ix.messageComponent(Ix.idStartsWith('poll-vote:'), PollVoteButton);

// ---------------------------------------------------------------------------
// poll-add:{pollId} button — returns modal immediately (no pre-gate)
// ---------------------------------------------------------------------------

export const PollAddButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.map(({ interaction }) => {
    const locale = userLocale(interaction);
    const customId = getCustomId(interaction);
    const messageId = interaction.message?.id;
    const channelId = interaction.channel_id;

    // custom_id: poll-add:{pollId}
    const colonIdx = customId.indexOf(':');
    const pollId = customId.slice(colonIdx + 1);

    return {
      type: DiscordTypes.InteractionCallbackTypes.MODAL,
      data: {
        custom_id: `poll-add-modal:${channelId}:${messageId}:${pollId}`,
        title: m.bot_poll_add_modal_title({}, { locale }),
        components: [
          {
            type: 1 as const,
            components: [
              {
                type: 4 as const,
                custom_id: 'poll-option-label',
                label: m.bot_poll_add_modal_label({}, { locale }),
                style: 1 as const,
                required: true,
                max_length: 80,
              },
            ],
          },
        ],
      },
    };
  }),
  Effect.withSpan('interaction/poll-add-button'),
);

export const PollAddButtonReg = Ix.messageComponent(Ix.idStartsWith('poll-add:'), PollAddButton);

// ---------------------------------------------------------------------------
// poll-add-modal:{channelId}:{messageId}:{pollId} modal submit
// ---------------------------------------------------------------------------

export const PollAddModalSubmit = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'modal' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ interaction, rpc, rest }) => {
    const locale = userLocale(interaction);
    const embedLocale = guildLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);

    const customId = getCustomId(interaction);
    // custom_id: poll-add-modal:{channelId}:{messageId}:{pollId}
    const parts = customId.split(':');
    const mainChannelId = parts[1];
    const mainMessageId = parts[2];
    const pollIdRaw = parts[3];

    // Read raw member roles — NEVER transform to boolean
    const rawMemberRoles: unknown = interaction.member?.roles;
    const memberRoleIds: ReadonlyArray<string> = Array.isArray(rawMemberRoles)
      ? rawMemberRoles.filter((r): r is string => typeof r === 'string')
      : [];

    const label = readModalFieldValue(interaction, 'poll-option-label') ?? '';

    // Guard: DM-context interactions have no guild_id — return ephemeral error immediately.
    if (guildId === undefined) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_poll_err_no_guild({}, { locale }) },
            'Failed to update poll add-modal no-guild response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_poll_err_not_member({}, { locale }) },
            'Failed to update poll add-modal no-user response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    if (!pollIdRaw || !mainChannelId || !mainMessageId) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_poll_err_generic({}, { locale }) },
            'Failed to update poll add-modal invalid-id response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;
    const pollId = decodePollId(pollIdRaw);

    const addAndFollowUp = rpc['Poll/AddOption']({
      guild_id: decodeSnowflake(guildId),
      discord_user_id: discordUserId,
      poll_id: pollId,
      label,
      member_role_ids: memberRoleIds.map((r) => decodeSnowflake(r)),
    }).pipe(
      Effect.flatMap((result) => {
        const rebuildEffect = rebuildBoardMessage(
          rest,
          decodeSnowflake(mainChannelId),
          decodeSnowflake(mainMessageId),
          result.view,
          embedLocale,
        );

        return rebuildEffect.pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_poll_option_added({}, { locale }) },
              'Failed to update poll option-added response',
            ),
          ),
        );
      }),
      Effect.catchTag('PollAddOptionForbidden', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_captain({}, { locale }) },
          'Failed to update poll add-option-forbidden response',
        ),
      ),
      Effect.catchTag('PollOptionLimitReached', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_option_max_reached({}, { locale }) },
          'Failed to update poll option-limit-reached response',
        ),
      ),
      Effect.catchTag('PollDuplicateOption', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_option_duplicate({}, { locale }) },
          'Failed to update poll duplicate-option response',
        ),
      ),
      Effect.catchTag('PollOptionTooLong', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_option_length({}, { locale }) },
          'Failed to update poll option-too-long response',
        ),
      ),
      Effect.catchTag('PollClosed', () =>
        // Poll was lazy-closed — fetch the current view and rebuild the board to reflect
        // the closed state, so the public message stops showing live vote buttons.
        // Lock-held-during-rebuild tradeoff is acceptable at team scale.
        rpc['Poll/GetPollView']({
          guild_id: decodeSnowflake(guildId),
          discord_user_id: discordUserId,
          poll_id: pollId,
        }).pipe(
          Effect.flatMap((viewOption) =>
            Option.match(viewOption, {
              onNone: () => Effect.void,
              onSome: (view) =>
                rebuildBoardMessage(
                  rest,
                  decodeSnowflake(mainChannelId),
                  decodeSnowflake(mainMessageId),
                  view,
                  embedLocale,
                ),
            }),
          ),
          Effect.catchTag('PollGuildNotFound', () => Effect.void),
          Effect.catchTag('PollNotMember', () => Effect.void),
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_poll_closed_notice({}, { locale }) },
              'Failed to update poll closed notice from add',
            ),
          ),
        ),
      ),
      Effect.catchTag('PollNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_found({}, { locale }) },
          'Failed to update poll not-found response',
        ),
      ),
      Effect.catchTag('PollNotMember', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_member({}, { locale }) },
          'Failed to update poll not-member response',
        ),
      ),
      Effect.catchTag('PollGuildNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_no_guild({}, { locale }) },
          'Failed to update poll guild-not-found response',
        ),
      ),
    );

    return Effect.as(Effect.forkDetach(addAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/poll-add-modal'),
);

export const PollAddModalReg = Ix.modalSubmit(
  Ix.idStartsWith('poll-add-modal:'),
  PollAddModalSubmit,
);

// ---------------------------------------------------------------------------
// poll-close:{pollId} button
// ---------------------------------------------------------------------------

export const PollCloseButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ interaction, rpc, rest }) => {
    const locale = userLocale(interaction);
    const embedLocale = guildLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);
    const customId = getCustomId(interaction);

    // custom_id: poll-close:{pollId}
    const colonIdx = customId.indexOf(':');
    const pollIdRaw = customId.slice(colonIdx + 1);

    // Guard: DM-context interactions have no guild_id — return ephemeral error immediately.
    if (guildId === undefined) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_poll_err_no_guild({}, { locale }) },
            'Failed to update poll close no-guild response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_poll_err_not_member({}, { locale }) },
            'Failed to update poll close no-user response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;
    const pollId = decodePollId(pollIdRaw);

    const closeAndFollowUp = rpc['Poll/ClosePoll']({
      guild_id: decodeSnowflake(guildId),
      discord_user_id: discordUserId,
      poll_id: pollId,
    }).pipe(
      Effect.flatMap((view) =>
        rebuildBoard(rest, view, embedLocale).pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_poll_closed({}, { locale }) },
              'Failed to update poll closed response',
            ),
          ),
        ),
      ),
      Effect.catchTag('PollForbidden', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_captain({}, { locale }) },
          'Failed to update poll close-forbidden response',
        ),
      ),
      Effect.catchTag('PollNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_found({}, { locale }) },
          'Failed to update poll close not-found response',
        ),
      ),
      Effect.catchTag('PollNotMember', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_not_member({}, { locale }) },
          'Failed to update poll close not-member response',
        ),
      ),
      Effect.catchTag('PollGuildNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_poll_err_no_guild({}, { locale }) },
          'Failed to update poll close guild-not-found response',
        ),
      ),
    );

    return Effect.as(Effect.forkDetach(closeAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/poll-close-button'),
);

export const PollCloseButtonReg = Ix.messageComponent(
  Ix.idStartsWith('poll-close:'),
  PollCloseButton,
);
