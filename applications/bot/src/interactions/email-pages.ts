import { EmailForwarding, Team } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildPageComponents, buildPageEmbed } from '~/rest/email/buildEmailEmbeds.js';
import { chunkForEmbedDescription } from '~/rest/email/chunkText.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeTeamIdOption = Schema.decodeUnknownOption(Team.TeamId);
const decodeEmailMessageIdOption = Schema.decodeUnknownOption(EmailForwarding.EmailMessageId);

type Kind = 'detailed' | 'original';

/**
 * Fetch email content, determine text by kind, chunk it, render a page, and
 * call updateOriginalWebhookMessage. On error, render an error message instead.
 */
const fetchAndRenderPage = (
  rpc: typeof SyncRpc.Service,
  rest: DiscordRestService,
  interaction: Discord.APIInteraction,
  teamId: Team.TeamId,
  emailId: EmailForwarding.EmailMessageId,
  kind: Kind,
  requestedPageIndex: number,
  locale: ReturnType<typeof userLocale>,
) => {
  const errorUpdate = (content: string) =>
    rest
      .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
        payload: { content, allowed_mentions: { parse: [] } },
      })
      .pipe(
        Effect.catchTag('HttpClientError', (err) =>
          Effect.logError('email-pages: failed to send error update', err),
        ),
        Effect.catchTag('RatelimitedResponse', (err) =>
          Effect.logError('email-pages: failed to send error update', err),
        ),
        Effect.catchTag('ErrorResponse', (err) =>
          Effect.logError('email-pages: failed to send error update', err),
        ),
        Effect.asVoid,
      );

  return rpc['Email/GetEmailContent']({ team_id: teamId, email_id: emailId }).pipe(
    Effect.flatMap((content) => {
      const text =
        kind === 'detailed' ? Option.getOrElse(content.summary, () => content.body) : content.body;

      const chunks = chunkForEmbedDescription(text);
      const totalPages = chunks.length;
      // Clamp to valid range
      const pageIndex = Math.max(0, Math.min(requestedPageIndex, totalPages - 1));
      const pageText = chunks[pageIndex] ?? '';

      const embed = buildPageEmbed({
        kind,
        teamId,
        emailId,
        pageText,
        pageIndex,
        totalPages,
        subject: content.subject,
        locale,
      });

      const components = buildPageComponents({
        kind,
        teamId,
        emailId,
        pageIndex,
        totalPages,
        locale,
      });

      return rest
        .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
          payload: {
            embeds: [embed],
            components,
            allowed_mentions: { parse: [] },
          },
        })
        .pipe(
          Effect.catchTag('HttpClientError', (err) =>
            Effect.logError('email-pages: failed to update page', err),
          ),
          Effect.catchTag('RatelimitedResponse', (err) =>
            Effect.logError('email-pages: failed to update page', err),
          ),
          Effect.catchTag('ErrorResponse', (err) =>
            Effect.logError('email-pages: failed to update page', err),
          ),
          Effect.asVoid,
        );
    }),
    Effect.catchTag('EmailRpcMessageNotFound', () =>
      errorUpdate(m.bot_email_page_empty({}, { locale })),
    ),
    Effect.catchTag('RpcClientError', () => errorUpdate(m.bot_email_page_empty({}, { locale }))),
  );
};

const makeOpenHandler = (kind: Kind, idPrefix: string) =>
  Ix.messageComponent(
    Ix.idStartsWith(idPrefix),
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
        // custom_id: email-detail:{teamId}:{emailId}
        // UUIDs use hyphens not colons, so split(':') is safe:
        // parts[0] = 'email-detail'
        // parts[1] = teamId UUID
        // parts[2] = emailId UUID
        const teamIdOption = decodeTeamIdOption(parts[1]);
        const emailIdOption = decodeEmailMessageIdOption(parts[2]);
        const locale = userLocale(interaction);

        const deferred: Discord.CreateMessageInteractionCallbackRequest = {
          type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: Discord.MessageFlags.Ephemeral },
        };

        if (Option.isNone(teamIdOption) || Option.isNone(emailIdOption)) {
          const errorWork = rest
            .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
              payload: {
                content: m.bot_email_page_empty({}, { locale }),
                allowed_mentions: { parse: [] },
              },
            })
            .pipe(
              Effect.catchTag('HttpClientError', (err) =>
                Effect.logError('email-pages: failed to send malformed-id error', err),
              ),
              Effect.catchTag('RatelimitedResponse', (err) =>
                Effect.logError('email-pages: failed to send malformed-id error', err),
              ),
              Effect.catchTag('ErrorResponse', (err) =>
                Effect.logError('email-pages: failed to send malformed-id error', err),
              ),
              Effect.asVoid,
            );
          return Effect.as(Effect.forkDetach(errorWork), deferred);
        }

        const teamId = teamIdOption.value;
        const emailId = emailIdOption.value;

        const work = fetchAndRenderPage(rpc, rest, interaction, teamId, emailId, kind, 0, locale);

        return Effect.as(Effect.forkDetach(work), deferred);
      }),
      Effect.withSpan(`interaction/${idPrefix.replace(':', '')}`),
    ),
  );

const makePageHandler = (kind: Kind, idPrefix: string) =>
  Ix.messageComponent(
    Ix.idStartsWith(idPrefix),
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
        // custom_id: email-detail-page:{teamId}:{emailId}:{pageIndex}
        // parts[0] = 'email-detail-page'
        // parts[1] = teamId UUID
        // parts[2] = emailId UUID
        // parts[3] = pageIndex (number)
        const teamIdOption = decodeTeamIdOption(parts[1]);
        const emailIdOption = decodeEmailMessageIdOption(parts[2]);
        const requestedPageIndex = Number(parts[3]) || 0;
        const locale = userLocale(interaction);

        const deferredUpdate = Ix.response({
          type: Discord.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
        });

        if (Option.isNone(teamIdOption) || Option.isNone(emailIdOption)) {
          const errorWork = rest
            .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
              payload: {
                content: m.bot_email_page_empty({}, { locale }),
                allowed_mentions: { parse: [] },
              },
            })
            .pipe(
              Effect.catchTag('HttpClientError', (err) =>
                Effect.logError('email-pages: failed to send malformed-id error', err),
              ),
              Effect.catchTag('RatelimitedResponse', (err) =>
                Effect.logError('email-pages: failed to send malformed-id error', err),
              ),
              Effect.catchTag('ErrorResponse', (err) =>
                Effect.logError('email-pages: failed to send malformed-id error', err),
              ),
              Effect.asVoid,
            );
          return Effect.as(Effect.forkDetach(errorWork), deferredUpdate);
        }

        const teamId = teamIdOption.value;
        const emailId = emailIdOption.value;

        const work = fetchAndRenderPage(
          rpc,
          rest,
          interaction,
          teamId,
          emailId,
          kind,
          requestedPageIndex,
          locale,
        );

        return Effect.as(Effect.forkDetach(work), deferredUpdate);
      }),
      Effect.withSpan(`interaction/${idPrefix.replace(':', '')}`),
    ),
  );

export const EmailDetailOpenButton = makeOpenHandler('detailed', 'email-detail:');
export const EmailOriginalOpenButton = makeOpenHandler('original', 'email-original:');
export const EmailDetailPageButton = makePageHandler('detailed', 'email-detail-page:');
export const EmailOriginalPageButton = makePageHandler('original', 'email-original-page:');
