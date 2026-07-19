import { Discord as DiscordSchemas, Event, Team } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/**
 * Terminal backstop for a detached fork that resolves a deferred ephemeral
 * reply. On ANY unhandled failure or defect (e.g. a transient `RpcClientError`
 * or a server-side `LogicError.die` surfaced as a defect) it logs the cause and
 * still writes a generic error message, so the user is never left on "Sideline
 * is thinking…". Mirrors the profile-complete / event-create backstop.
 */
const withBackstop =
  (
    rest: DiscordRestService,
    interaction: Discord.APIInteraction,
    locale: Locale,
    context: string,
  ) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(context, cause).pipe(
          Effect.andThen(
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: { content: m.bot_claim_error({}, { locale }) },
              })
              .pipe(
                Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
                  Effect.logError('Failed to update claim error response', e),
                ),
              ),
          ),
        ),
      ),
    );

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeEventId = Schema.decodeUnknownSync(Event.EventId);
const decodeTeamId = Schema.decodeUnknownSync(Team.TeamId);

export const ClaimButton = Ix.messageComponent(
  Ix.idStartsWith('claim:'),
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
      const teamId = decodeTeamId(parts[1]);
      const eventId = decodeEventId(parts[2]);
      const discordUserIdOption = interactionUserId(interaction);
      const locale = userLocale(interaction);

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_claim_not_owner({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const claimAndFollowUp = rpc['Event/ClaimTraining']({
        event_id: eventId,
        team_id: teamId,
        discord_user_id: discordUserId,
      }).pipe(
        Effect.map(() => m.bot_claim_success({}, { locale })),
        Effect.catchTag('ClaimAlreadyClaimed', (err) => {
          const user = Option.match(err.claimer_display, {
            onNone: () => '?',
            onSome: (name) => `**${name}**`,
          });
          return Effect.succeed(m.bot_claim_already_claimed_by({ user }, { locale }));
        }),
        Effect.catchTag('ClaimNotOwnerGroupMember', () =>
          Effect.succeed(m.bot_claim_not_owner({}, { locale })),
        ),
        Effect.catchTag('ClaimEventInactive', () =>
          Effect.succeed(m.bot_claim_event_cancelled({}, { locale })),
        ),
        Effect.catchTag('ClaimEventNotFound', () =>
          Effect.succeed(m.bot_claim_event_cancelled({}, { locale })),
        ),
        Effect.catchTag('ClaimNotTraining', () =>
          Effect.succeed(m.bot_claim_event_cancelled({}, { locale })),
        ),
        Effect.flatMap((content) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('ClaimButton: failed to update follow-up message', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(
        Effect.forkDetach(
          claimAndFollowUp.pipe(
            withBackstop(rest, interaction, locale, 'claim: unexpected failure'),
          ),
        ),
        deferred,
      );
    }),
    Effect.withSpan('interaction/claim-button'),
  ),
);

export const UnclaimButton = Ix.messageComponent(
  Ix.idStartsWith('unclaim:'),
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
      const teamId = decodeTeamId(parts[1]);
      const eventId = decodeEventId(parts[2]);
      const discordUserIdOption = interactionUserId(interaction);
      const locale = userLocale(interaction);

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_claim_release_not_claimer({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const unclaimAndFollowUp = rpc['Event/UnclaimTraining']({
        event_id: eventId,
        team_id: teamId,
        discord_user_id: discordUserId,
      }).pipe(
        Effect.map(() => m.bot_claim_release_success({}, { locale })),
        Effect.catchTag('ClaimNotClaimer', () =>
          Effect.succeed(m.bot_claim_release_not_claimer({}, { locale })),
        ),
        Effect.catchTag('ClaimEventInactive', () =>
          Effect.succeed(m.bot_claim_event_cancelled({}, { locale })),
        ),
        Effect.catchTag('ClaimEventNotFound', () =>
          Effect.succeed(m.bot_claim_event_cancelled({}, { locale })),
        ),
        Effect.flatMap((content) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('UnclaimButton: failed to update follow-up message', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(
        Effect.forkDetach(
          unclaimAndFollowUp.pipe(
            withBackstop(rest, interaction, locale, 'unclaim: unexpected failure'),
          ),
        ),
        deferred,
      );
    }),
    Effect.withSpan('interaction/unclaim-button'),
  ),
);
