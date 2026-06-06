import {
  Discord as DiscordSchemas,
  Event,
  type EventRpcModels,
  EventRsvp,
  Team,
} from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData, ModalSubmitData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { DateTime, Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildEventEmbed, YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { formatNameWithMention } from '~/rest/utils.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

const localizeRsvpResponse = (response: EventRsvp.RsvpResponse, locale: Locale): string => {
  switch (response) {
    case 'yes':
      return m.rsvp_yes({}, { locale });
    case 'no':
      return m.rsvp_no({}, { locale });
    case 'maybe':
      return m.rsvp_maybe({}, { locale });
  }
};

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeEventId = Schema.decodeUnknownSync(Event.EventId);
const decodeTeamId = Schema.decodeUnknownSync(Team.TeamId);
const decodeRsvpResponse = Schema.decodeUnknownSync(EventRsvp.RsvpResponse);

const buildMessageActionRow = (
  teamId: string,
  eventId: string,
  response: EventRsvp.RsvpResponse,
  locale: Locale,
  hasMessage: boolean,
): Discord.ActionRowComponentForMessageRequest => ({
  type: 1,
  components: hasMessage
    ? [
        {
          type: 2,
          style: 2,
          label: m.bot_rsvp_edit_message({}, { locale }),
          custom_id: `rsvp-add-msg:${teamId}:${eventId}:${response}`,
        },
        {
          type: 2,
          style: 4,
          label: m.bot_rsvp_clear_message({}, { locale }),
          custom_id: `rsvp-clear-msg:${teamId}:${eventId}:${response}`,
        },
      ]
    : [
        {
          type: 2,
          style: 2,
          label: m.bot_rsvp_add_message({}, { locale }),
          custom_id: `rsvp-add-msg:${teamId}:${eventId}:${response}`,
        },
      ],
});

const modalValueOption = (
  submission: Discord.APIModalSubmission,
  customId: string,
): Option.Option<string> => {
  for (const row of submission.components ?? []) {
    if (row.type !== 1) continue;
    for (const comp of row.components) {
      if (comp.custom_id === customId) {
        return comp.value && comp.value.trim().length > 0
          ? Option.some(comp.value.trim())
          : Option.none();
      }
    }
  }
  return Option.none();
};

export const postRsvpDiscordUpdates = (params: {
  interaction: Discord.APIInteraction;
  rpc: SyncRpcClient;
  rest: DiscordRestService;
  eventId: Event.EventId;
  teamId: Team.TeamId;
  response: EventRsvp.RsvpResponse;
  discordUserId: DiscordSchemas.Snowflake;
  counts: EventRpcModels.SubmitRsvpResult;
}) => {
  const { interaction, rpc, rest, eventId, teamId, response, discordUserId, counts } = params;
  const guildId = interaction.guild_id;
  if (guildId === undefined) return Effect.void;
  return Effect.all([
    rpc['Event/GetDiscordMessageId']({ event_id: eventId }),
    rpc['Event/GetEventEmbedInfo']({ event_id: eventId }),
    rpc['Event/GetYesAttendeesForEmbed']({
      event_id: eventId,
      limit: YES_EMBED_LIMIT,
      member_group_id: Option.none(),
    }),
    rest.getGuild(guildId),
  ] as const).pipe(
    Effect.flatMap(([stored, embedInfo, yesAttendees, guild]) => {
      const embedLocale = guildLocale({ guild_locale: guild.preferred_locale });

      const updateEmbed = Option.match(stored, {
        onNone: () => Effect.void,
        onSome: (msg) =>
          Option.match(embedInfo, {
            onNone: () => Effect.void,
            onSome: (info) => {
              const isStarted = DateTime.isGreaterThanOrEqualTo(
                DateTime.nowUnsafe(),
                info.start_at,
              );
              const payload = buildEventEmbed({
                teamId,
                eventId,
                title: info.title,
                description: info.description,
                imageUrl: info.image_url,
                startAt: info.start_at,
                endAt: info.end_at,
                location: info.location,
                locationUrl: info.location_url,
                eventType: info.event_type,
                counts,
                yesAttendees,
                locale: embedLocale,
                isStarted,
                allDay: info.all_day,
              });
              return rest.updateMessage(msg.discord_channel_id, msg.discord_message_id, {
                embeds: payload.embeds,
                components: payload.components,
              });
            },
          }),
      });

      const notifyLateRsvp = counts.isLateRsvp
        ? Option.match(counts.lateRsvpChannelId, {
            onNone: () => Effect.void,
            onSome: (channelId) => {
              const eventTitle = Option.match(embedInfo, {
                onNone: () => m.bot_rsvp_event_not_found({}, { locale: embedLocale }),
                onSome: (i) => i.title,
              });
              const userDisplay = formatNameWithMention({
                discord_id: Option.some(discordUserId),
                name: counts.userName,
                nickname: counts.userNickname,
                display_name: counts.userDisplayName,
                username: counts.userUsername,
              });
              return rest.createMessage(channelId, {
                embeds: [
                  {
                    color: 0xe67e22,
                    description: m.bot_late_rsvp_notification(
                      {
                        user: userDisplay,
                        response: localizeRsvpResponse(response, embedLocale),
                        event: eventTitle,
                      },
                      { locale: embedLocale },
                    ),
                  },
                ],
              });
            },
          })
        : Effect.void;

      return Effect.all([updateEmbed, notifyLateRsvp], {
        concurrency: 'unbounded',
      }).pipe(Effect.asVoid);
    }),
    Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
      Effect.logError('Failed to handle post-RSVP Discord updates', error),
    ),
  );
};

export const RsvpButton = Ix.messageComponent(
  Ix.idStartsWith('rsvp:'),
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
      const response = decodeRsvpResponse(parts[3]);
      const discordUserIdOption = interactionUserId(interaction);
      const locale = userLocale(interaction);

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_rsvp_user_error({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const submitAndFollowUp = rpc['Event/SubmitRsvp']({
        event_id: eventId,
        team_id: teamId,
        discord_user_id: discordUserId,
        response,
        message: Option.none(),
        clearMessage: false,
      }).pipe(
        Effect.tap((counts) =>
          postRsvpDiscordUpdates({
            interaction,
            rpc,
            rest,
            eventId,
            teamId,
            response,
            discordUserId,
            counts,
          }),
        ),
        Effect.map(
          (counts) =>
            ({
              _tag: 'success' as const,
              hasMessage: Option.isSome(counts.message),
              content: counts.isLateRsvp
                ? `${m.bot_rsvp_recorded({ response: localizeRsvpResponse(response, locale) }, { locale })}\n\n${m.bot_rsvp_late_hint({}, { locale })}`
                : m.bot_rsvp_recorded(
                    { response: localizeRsvpResponse(response, locale) },
                    { locale },
                  ),
            }) as const,
        ),
        Effect.catchTag('RsvpDeadlinePassed', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_deadline_passed({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpMemberNotFound', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_not_member({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpNotGroupMember', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_not_group_member({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpEventNotFound', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_event_not_found({}, { locale }),
          }),
        ),
        Effect.flatMap((result) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload:
              result._tag === 'success'
                ? {
                    content: result.content,
                    components: [
                      buildMessageActionRow(
                        parts[1],
                        parts[2],
                        response,
                        locale,
                        result.hasMessage,
                      ),
                    ],
                  }
                : { content: result.content },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('Failed to update RSVP response', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(submitAndFollowUp), deferred);
    }),
    Effect.withSpan('interaction/rsvp-button'),
  ),
);

export const RsvpAddMessageButton = Ix.messageComponent(
  Ix.idStartsWith('rsvp-add-msg:'),
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
        1,
      ),
    ),
    Effect.bind('data', () => MessageComponentData.asEffect()),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.map(({ data, interaction }) => {
      const parts = data.custom_id.split(':');
      const teamId = parts[1];
      const eventId = parts[2];
      const response = decodeRsvpResponse(parts[3]);
      const locale = userLocale(interaction);
      return Ix.response({
        type: Discord.InteractionCallbackTypes.MODAL,
        data: {
          custom_id: `rsvp-modal:${teamId}:${eventId}:${response}`,
          title: m.bot_rsvp_modal_title(
            { response: localizeRsvpResponse(response, locale) },
            { locale },
          ),
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: 'rsvp_message',
                  label: m.bot_rsvp_modal_label({}, { locale }),
                  style: 2,
                  required: false,
                  max_length: 200,
                },
              ],
            },
          ],
        },
      });
    }),
    Effect.withSpan('interaction/rsvp-add-message-button'),
  ),
);

export const RsvpClearMessageButton = Ix.messageComponent(
  Ix.idStartsWith('rsvp-clear-msg:'),
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
      const response = decodeRsvpResponse(parts[3]);
      const discordUserIdOption = interactionUserId(interaction);
      const locale = userLocale(interaction);

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_rsvp_user_error({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const clearAndFollowUp = rpc['Event/SubmitRsvp']({
        event_id: eventId,
        team_id: teamId,
        discord_user_id: discordUserId,
        response,
        message: Option.none(),
        clearMessage: true,
      }).pipe(
        Effect.tap((counts) =>
          postRsvpDiscordUpdates({
            interaction,
            rpc,
            rest,
            eventId,
            teamId,
            response,
            discordUserId,
            counts,
          }),
        ),
        Effect.map(
          () =>
            ({
              _tag: 'success' as const,
              content: m.bot_rsvp_message_cleared(
                { response: localizeRsvpResponse(response, locale) },
                { locale },
              ),
            }) as const,
        ),
        Effect.catchTag('RsvpDeadlinePassed', () =>
          Effect.succeed({
            _tag: 'error' as const,
            content: m.bot_rsvp_deadline_passed({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpMemberNotFound', () =>
          Effect.succeed({
            _tag: 'error' as const,
            content: m.bot_rsvp_not_member({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpNotGroupMember', () =>
          Effect.succeed({
            _tag: 'error' as const,
            content: m.bot_rsvp_not_group_member({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpEventNotFound', () =>
          Effect.succeed({
            _tag: 'error' as const,
            content: m.bot_rsvp_event_not_found({}, { locale }),
          }),
        ),
        Effect.flatMap((result) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload:
              result._tag === 'success'
                ? {
                    content: result.content,
                    components: [
                      buildMessageActionRow(parts[1], parts[2], response, locale, false),
                    ],
                  }
                : { content: result.content },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('Failed to update RSVP response', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(clearAndFollowUp), deferred);
    }),
    Effect.withSpan('interaction/rsvp-clear-message-button'),
  ),
);

export const RsvpModal = Ix.modalSubmit(
  Ix.idStartsWith('rsvp-modal:'),
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'modal' }),
        1,
      ),
    ),
    Effect.bind('data', () => ModalSubmitData.asEffect()),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ data, interaction, rpc, rest }) => {
      const parts = data.custom_id.split(':');
      const teamId = decodeTeamId(parts[1]);
      const eventId = decodeEventId(parts[2]);
      const response = decodeRsvpResponse(parts[3]);
      const message = modalValueOption(data, 'rsvp_message');
      const discordUserIdOption = interactionUserId(interaction);
      const locale = userLocale(interaction);

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_rsvp_user_error({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);

      const submitAndFollowUp = rpc['Event/SubmitRsvp']({
        event_id: eventId,
        team_id: teamId,
        discord_user_id: discordUserId,
        response,
        message,
        clearMessage: false,
      }).pipe(
        Effect.tap((counts) =>
          postRsvpDiscordUpdates({
            interaction,
            rpc,
            rest,
            eventId,
            teamId,
            response,
            discordUserId,
            counts,
          }),
        ),
        Effect.map(
          (counts) =>
            ({
              _tag: 'success' as const,
              hasMessage: Option.isSome(counts.message),
              content: m.bot_rsvp_message_saved(
                { response: localizeRsvpResponse(response, locale) },
                { locale },
              ),
            }) as const,
        ),
        Effect.catchTag('RsvpDeadlinePassed', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_deadline_passed({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpMemberNotFound', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_not_member({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpNotGroupMember', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_not_group_member({}, { locale }),
          }),
        ),
        Effect.catchTag('RsvpEventNotFound', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_event_not_found({}, { locale }),
          }),
        ),
        Effect.flatMap((result) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload:
              result._tag === 'success'
                ? {
                    content: result.content,
                    components: [
                      buildMessageActionRow(
                        parts[1],
                        parts[2],
                        response,
                        locale,
                        result.hasMessage,
                      ),
                    ],
                  }
                : { content: result.content },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('Failed to update RSVP response', error),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(submitAndFollowUp), deferred);
    }),
    Effect.withSpan('interaction/rsvp-modal'),
  ),
);
