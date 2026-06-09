import {
  Discord as DiscordSchemas,
  EmailForwarding,
  type EmailRpcModels,
  Team,
} from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import type { RpcClientError as RpcClientErrorNs } from 'effect/unstable/rpc';
import { type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflakeOption = Schema.decodeUnknownOption(DiscordSchemas.Snowflake);
const decodeTeamIdOption = Schema.decodeUnknownOption(Team.TeamId);
const decodeEmailMessageIdOption = Schema.decodeUnknownOption(EmailForwarding.EmailMessageId);

const buildDisabledApprovalRow = (): Discord.ActionRowComponentForMessageRequest => ({
  type: 1,
  components: [
    {
      type: 2,
      style: 3,
      label: m.bot_email_btn_approve({}, { locale: 'en' }),
      custom_id: 'email-approve:disabled',
      disabled: true,
    },
    {
      type: 2,
      style: 4,
      label: m.bot_email_btn_reject({}, { locale: 'en' }),
      custom_id: 'email-reject:disabled',
      disabled: true,
    },
  ],
});

const ephemeralResponse = (content: string) =>
  Ix.response({
    type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: Discord.MessageFlags.Ephemeral },
  });

const editFollowUp = (
  rest: DiscordRestService,
  interaction: Discord.APIInteraction,
  content: string,
) =>
  rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
      payload: { content, allowed_mentions: { parse: [] } },
    })
    .pipe(Effect.asVoid);

type SyncRpcClient = typeof SyncRpc.Service;

/**
 * Shared implementation for the approve and reject buttons. The two only differ
 * in the RPC method invoked, the success message, and the span/log labels.
 */
const makeEmailDecisionButton = (config: {
  readonly idPrefix: string;
  readonly invoke: (
    rpc: SyncRpcClient,
    input: {
      readonly team_id: Team.TeamId;
      readonly email_id: EmailForwarding.EmailMessageId;
      readonly discord_user_id: DiscordSchemas.Snowflake;
    },
  ) => Effect.Effect<
    {
      readonly outcome: 'approved' | 'sent_original' | 'dismissed' | 'already_handled';
    },
    | EmailRpcModels.EmailApprovalForbidden
    | EmailRpcModels.EmailRpcMessageNotFound
    | RpcClientErrorNs.RpcClientError
  >;
  readonly successMessage: (user: DiscordSchemas.Snowflake, locale: Locale) => string;
  readonly spanName: string;
  readonly disableButtonsLogLabel: string;
  readonly followUpFailureLog: string;
}) =>
  Ix.messageComponent(
    Ix.idStartsWith(config.idPrefix),
    Effect.Do.pipe(
      Effect.tap(() =>
        Metric.update(
          Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
          1,
        ),
      ),
      Effect.bind('data', () => MessageComponentData.asEffect()),
      Effect.bind('interaction', () => Interaction.asEffect()),
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ data, interaction, rpc, rest }) => {
        const parts = data.custom_id.split(':');
        const teamIdOption = decodeTeamIdOption(parts[1]);
        const emailIdOption = decodeEmailMessageIdOption(parts[2]);
        const discordUserIdOption = interactionUserId(interaction);
        const locale = userLocale(interaction);

        if (Option.isNone(discordUserIdOption)) {
          return Effect.succeed(ephemeralResponse(m.bot_email_not_authorized({}, { locale })));
        }

        if (Option.isNone(teamIdOption) || Option.isNone(emailIdOption)) {
          return Effect.succeed(ephemeralResponse(m.bot_email_not_found({}, { locale })));
        }

        const discordUserIdSnowflakeOpt = decodeSnowflakeOption(discordUserIdOption.value);
        if (Option.isNone(discordUserIdSnowflakeOpt)) {
          return Effect.succeed(ephemeralResponse(m.bot_email_not_authorized({}, { locale })));
        }

        const teamId = teamIdOption.value;
        const emailId = emailIdOption.value;
        const discordUserId = discordUserIdSnowflakeOpt.value;
        const channelId = interaction.channel_id;
        const messageId = interaction.message?.id;

        const decideAndFollowUp = config
          .invoke(rpc, {
            team_id: teamId,
            email_id: emailId,
            discord_user_id: discordUserId,
          })
          .pipe(
            Effect.flatMap(({ outcome }) => {
              const ephemeralContent =
                outcome === 'already_handled'
                  ? m.bot_email_already_handled({}, { locale })
                  : config.successMessage(discordUserId, locale);

              const editOriginal =
                channelId !== undefined && messageId !== undefined
                  ? rest
                      .updateMessage(channelId, messageId, {
                        components: [buildDisabledApprovalRow()],
                        allowed_mentions: { parse: [] },
                      })
                      .pipe(
                        Effect.catchTag(
                          ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                          (err) =>
                            Effect.logWarning(`${config.disableButtonsLogLabel} ${messageId}`, err),
                        ),
                        Effect.asVoid,
                      )
                  : Effect.void;

              return Effect.all([
                editFollowUp(rest, interaction, ephemeralContent),
                editOriginal,
              ]).pipe(Effect.asVoid);
            }),
            Effect.catchTag('EmailApprovalForbidden', () =>
              editFollowUp(rest, interaction, m.bot_email_not_authorized({}, { locale })),
            ),
            Effect.catchTag('EmailRpcMessageNotFound', () =>
              editFollowUp(rest, interaction, m.bot_email_not_found({}, { locale })),
            ),
            Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
              Effect.logError(config.followUpFailureLog, error),
            ),
          );

        const deferred: Discord.CreateMessageInteractionCallbackRequest = {
          type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: Discord.MessageFlags.Ephemeral },
        };
        return Effect.as(Effect.forkDetach(decideAndFollowUp), deferred);
      }),
      Effect.withSpan(config.spanName),
    ),
  );

export const EmailApproveButton = makeEmailDecisionButton({
  idPrefix: 'email-approve:',
  invoke: (rpc, input) => rpc['Email/RecordApproval'](input),
  successMessage: (user, locale) => m.bot_email_approved_by({ user }, { locale }),
  spanName: 'interaction/email-approve-button',
  disableButtonsLogLabel: 'Failed to disable approval buttons on message',
  followUpFailureLog: 'EmailApproveButton: failed to update follow-up',
});

export const EmailRejectButton = makeEmailDecisionButton({
  idPrefix: 'email-reject:',
  invoke: (rpc, input) => rpc['Email/RecordReject'](input),
  successMessage: (user, locale) => m.bot_email_rejected_by({ user }, { locale }),
  spanName: 'interaction/email-reject-button',
  disableButtonsLogLabel: 'Failed to disable rejection buttons on message',
  followUpFailureLog: 'EmailRejectButton: failed to update follow-up',
});

export const EmailSendOriginalButton = makeEmailDecisionButton({
  idPrefix: 'email-send-original:',
  invoke: (rpc, input) => rpc['Email/RecordSendOriginal'](input),
  successMessage: (user, locale) => m.bot_email_original_sent_by({ user }, { locale }),
  spanName: 'interaction/email-send-original-button',
  disableButtonsLogLabel: 'Failed to disable send-original buttons on message',
  followUpFailureLog: 'EmailSendOriginalButton: failed to update follow-up',
});
