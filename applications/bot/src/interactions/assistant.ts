/**
 * Confirm / Discard on an assistant proposal card (`/assistant` threads). The proposal's data
 * lives server-side; the button only names it, and the server re-checks that the clicker is the
 * person it was proposed to and still holds the action's permissions — the same confirm path
 * the web card uses.
 */
import { AiActionProposal, Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { CONFIRM_PREFIX, confirmedLabels, REJECT_PREFIX } from '~/commands/assistant/render.js';
import { threadOwner } from '~/commands/assistant/thread.js';
import { type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeProposalId = Schema.decodeUnknownOption(AiActionProposal.AiActionProposalId);

/** Terminal outcomes clear the buttons; a retryable failure leaves them in place. */
const proposalErrorText = (tag: string, locale: Locale): { text: string; terminal: boolean } => {
  switch (tag) {
    case 'AiProposalNotFound':
      return { text: m.assistant_proposal_errorNotFound({}, { locale }), terminal: true };
    case 'AiProposalAlreadyUsed':
      return { text: m.assistant_proposal_errorAlreadyUsed({}, { locale }), terminal: true };
    case 'AiProposalExpired':
      return { text: m.assistant_proposal_errorExpired({}, { locale }), terminal: true };
    case 'AiProposalActionForbidden':
    case 'AiChatForbidden':
    case 'AssistantNotMember':
    case 'AssistantNotLinked':
      return { text: m.assistant_proposal_errorForbidden({}, { locale }), terminal: false };
    default:
      return { text: m.assistant_proposal_errorGeneric({}, { locale }), terminal: false };
  }
};

const handleProposalButton = (kind: 'confirm' | 'reject') =>
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
        1,
      ),
    ),
    Effect.bind('data', () => MessageComponentData.asEffect()),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.map(({ data, interaction, rest, rpc }) => {
      const locale = userLocale(interaction);
      const prefix = kind === 'confirm' ? CONFIRM_PREFIX : REJECT_PREFIX;
      const proposalId = decodeProposalId(data.custom_id.slice(prefix.length));
      const userId = interactionUserId(interaction);
      const guildId = interaction.guild_id;
      const channelId = interaction.channel_id;

      // Edits the proposal card itself (the message the button sits on).
      const updateCard = (content: string, clearButtons: boolean) =>
        rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
          payload: clearButtons
            ? { content, components: [], allowed_mentions: { parse: [] } }
            : { content, allowed_mentions: { parse: [] } },
        });
      const notice = (content: string) =>
        rest.executeWebhook(interaction.application_id, interaction.token, {
          payload: { content, flags: Discord.MessageFlags.Ephemeral },
        });

      const work =
        Option.isNone(proposalId) ||
        Option.isNone(userId) ||
        guildId === undefined ||
        channelId === undefined
          ? notice(m.assistant_proposal_errorGeneric({}, { locale }))
          : threadOwner(channelId).pipe(
              Effect.flatMap((owner) => {
                if (owner === null || owner.owner_discord_id !== userId.value) {
                  return notice(m.bot_assistant_not_owner({}, { locale }));
                }
                const actor = {
                  guild_id: decodeSnowflake(guildId),
                  discord_user_id: userId.value,
                  proposal_id: proposalId.value,
                };
                // Every failure here is tagged; the tag picks the message.
                const call: Effect.Effect<string, { readonly _tag: string }> =
                  kind === 'confirm'
                    ? rpc['Assistant/ConfirmProposal'](actor).pipe(
                        Effect.map(({ outcome, action }) =>
                          outcome === 'queued'
                            ? m.assistant_proposal_discordQueued({}, { locale })
                            : confirmedLabels[action](locale),
                        ),
                      )
                    : rpc['Assistant/RejectProposal'](actor).pipe(
                        Effect.as(m.assistant_proposal_rejected({}, { locale })),
                      );
                return call.pipe(
                  Effect.flatMap((text) => updateCard(text, true)),
                  Effect.catch((e) => {
                    const { text, terminal } = proposalErrorText(e._tag, locale);
                    return terminal ? updateCard(text, true) : notice(text);
                  }),
                );
              }),
            );

      return work.pipe(
        Effect.catchCause((cause) =>
          Effect.logError('Assistant proposal button failed', cause).pipe(
            Effect.andThen(notice(m.assistant_proposal_errorGeneric({}, { locale }))),
            Effect.ignore,
          ),
        ),
      );
    }),
    Effect.flatMap((work) =>
      Effect.as(
        Effect.forkDetach(work),
        Ix.response({ type: Discord.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE }),
      ),
    ),
    Effect.withSpan(`interaction/assistant_${kind}`),
  );

export const AssistantConfirmButton = Ix.messageComponent(
  Ix.idStartsWith(CONFIRM_PREFIX),
  handleProposalButton('confirm'),
);

export const AssistantRejectButton = Ix.messageComponent(
  Ix.idStartsWith(REJECT_PREFIX),
  handleProposalButton('reject'),
);
