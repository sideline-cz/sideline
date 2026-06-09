import { Discord as DiscordSchemas, Event, EventRpcModels, Team } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeEventId = Schema.decodeUnknownSync(Event.EventId);
const decodeTeamId = Schema.decodeUnknownSync(Team.TeamId);
const decodeRequestId = Schema.decodeUnknownSync(EventRpcModels.JoinRequestId);

export const JoinRequestButton = Ix.messageComponent(
  Ix.idStartsWith('join-request:'),
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
              content: m.bot_join_not_member({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const submitAndFollowUp = rpc['Event/SubmitJoinRequest']({
        event_id: eventId,
        team_id: teamId,
        discord_user_id: discordUserId,
        message: Option.none(),
      }).pipe(
        Effect.map((result) => {
          // B4: branch on created flag and status to give the user the right feedback
          if (result.created) {
            return m.bot_join_request_submitted({}, { locale });
          }
          // Not created: row was already pending or accepted — request already exists
          return m.bot_join_request_already({}, { locale });
        }),
        Effect.catchTag('JoinRequestNotMember', () =>
          Effect.succeed(m.bot_join_not_member({}, { locale })),
        ),
        Effect.catchTag('JoinRequestEventInactive', () =>
          Effect.succeed(m.bot_join_event_inactive({}, { locale })),
        ),
        Effect.catchTag('JoinRequestNotTournament', () =>
          Effect.succeed(m.bot_join_event_inactive({}, { locale })),
        ),
        Effect.catchTag('JoinRequestEventNotFound', () =>
          Effect.succeed(m.bot_join_event_inactive({}, { locale })),
        ),
        Effect.flatMap((content) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content, allowed_mentions: { parse: [] } },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('JoinRequestButton: failed to update follow-up message', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(submitAndFollowUp), deferred);
    }),
    Effect.withSpan('interaction/join-request-button'),
  ),
);

export const JoinAcceptButton = Ix.messageComponent(
  Ix.idStartsWith('join-accept:'),
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
      const requestId = decodeRequestId(parts[2]);
      const discordUserIdOption = interactionUserId(interaction);
      const locale = userLocale(interaction);

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_join_not_captain({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const acceptAndFollowUp = rpc['Event/AcceptJoinRequest']({
        request_id: requestId,
        team_id: teamId,
        discord_user_id: discordUserId,
      }).pipe(
        Effect.map((result) => {
          const user = Option.getOrElse(result.member_display_name, () => '?');
          return m.bot_join_accept_success({ user: `**${user}**` }, { locale });
        }),
        Effect.catchTag('JoinRequestForbidden', () =>
          Effect.succeed(m.bot_join_not_captain({}, { locale })),
        ),
        Effect.catchTag('JoinRequestNotMember', () =>
          Effect.succeed(m.bot_join_not_captain({}, { locale })),
        ),
        Effect.catchTag('JoinRequestAlreadyDecided', () =>
          Effect.succeed(m.bot_join_decided_already({}, { locale })),
        ),
        Effect.flatMap((content) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content, allowed_mentions: { parse: [] } },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('JoinAcceptButton: failed to update follow-up message', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(acceptAndFollowUp), deferred);
    }),
    Effect.withSpan('interaction/join-accept-button'),
  ),
);

export const JoinDeclineButton = Ix.messageComponent(
  Ix.idStartsWith('join-decline:'),
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
      const requestId = decodeRequestId(parts[2]);
      const discordUserIdOption = interactionUserId(interaction);
      const locale = userLocale(interaction);

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_join_not_captain({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const declineAndFollowUp = rpc['Event/DeclineJoinRequest']({
        request_id: requestId,
        team_id: teamId,
        discord_user_id: discordUserId,
      }).pipe(
        Effect.map((result) => {
          const user = Option.getOrElse(result.member_display_name, () => '?');
          return m.bot_join_decline_success({ user: `**${user}**` }, { locale });
        }),
        Effect.catchTag('JoinRequestForbidden', () =>
          Effect.succeed(m.bot_join_not_captain({}, { locale })),
        ),
        Effect.catchTag('JoinRequestNotMember', () =>
          Effect.succeed(m.bot_join_not_captain({}, { locale })),
        ),
        Effect.catchTag('JoinRequestAlreadyDecided', () =>
          Effect.succeed(m.bot_join_decided_already({}, { locale })),
        ),
        Effect.flatMap((content) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content, allowed_mentions: { parse: [] } },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('JoinDeclineButton: failed to update follow-up message', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(declineAndFollowUp), deferred);
    }),
    Effect.withSpan('interaction/join-decline-button'),
  ),
);
