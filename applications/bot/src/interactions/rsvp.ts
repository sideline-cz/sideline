import {
  Discord as DiscordSchemas,
  Event,
  type EventRpcModels,
  EventRsvp,
  Team,
} from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData, ModalSubmitData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { formatNameWithMention } from '~/rest/utils.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

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
                payload: { content: m.bot_rsvp_error({}, { locale }) },
              })
              .pipe(
                Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
                  Effect.logError('Failed to update RSVP error response', e),
                ),
              ),
          ),
        ),
      ),
    );

const localizeRsvpResponse = (response: EventRsvp.RsvpResponse, locale: Locale): string => {
  switch (response) {
    case 'yes':
      return m.rsvp_yes({}, { locale });
    case 'no':
      return m.rsvp_no({}, { locale });
    case 'maybe':
      return m.rsvp_maybe({}, { locale });
    case 'coming_later':
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
): Discord.ActionRowComponentForMessageRequest =>
  UI.row(
    hasMessage
      ? [
          UI.button({
            style: Discord.ButtonStyleTypes.SECONDARY,
            label: m.bot_rsvp_edit_message({}, { locale }),
            custom_id: `rsvp-add-msg:${teamId}:${eventId}:${response}`,
          }),
          // coming_later requires a message, so clearing it is illegal — never
          // render the "clear message" button for that response.
          ...(response === 'coming_later'
            ? []
            : [
                UI.button({
                  style: Discord.ButtonStyleTypes.DANGER,
                  label: m.bot_rsvp_clear_message({}, { locale }),
                  custom_id: `rsvp-clear-msg:${teamId}:${eventId}:${response}`,
                }),
              ]),
        ]
      : [
          UI.button({
            style: Discord.ButtonStyleTypes.SECONDARY,
            label: m.bot_rsvp_add_message({}, { locale }),
            custom_id: `rsvp-add-msg:${teamId}:${eventId}:${response}`,
          }),
        ],
  );

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

/**
 * Post-RSVP Discord side effects. The shared board embed refresh is gone (the
 * board itself was removed) — personal channel messages refresh via the
 * server-side dirty-mark instead. The only remaining Discord-side effect here
 * is the late-RSVP notice to the configured late-RSVP channel, if any.
 */
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
  const { interaction, rpc, rest, eventId, response, discordUserId, counts } = params;
  const guildId = interaction.guild_id;
  if (guildId === undefined) return Effect.void;
  if (!counts.isLateRsvp || Option.isNone(counts.lateRsvpChannelId)) return Effect.void;
  const channelId = counts.lateRsvpChannelId.value;

  return Effect.all([
    rpc['Event/GetEventEmbedInfo']({ event_id: eventId }),
    rest.getGuild(guildId),
  ] as const).pipe(
    Effect.flatMap(([embedInfo, guild]) => {
      const embedLocale = guildLocale({ guild_locale: guild.preferred_locale });
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
      return rest
        .createMessage(channelId, {
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
        })
        .pipe(Effect.asVoid);
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
        Effect.catchTag('RsvpMessageRequired', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_message_required({}, { locale }),
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
      return Effect.as(
        Effect.forkDetach(
          submitAndFollowUp.pipe(
            withBackstop(rest, interaction, locale, 'rsvp-submit: unexpected failure'),
          ),
        ),
        deferred,
      );
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
      const required = response === 'coming_later';
      return Ix.response({
        type: Discord.InteractionCallbackTypes.MODAL,
        data: {
          custom_id: `rsvp-modal:${teamId}:${eventId}:${response}`,
          title: m.bot_rsvp_modal_title(
            { response: localizeRsvpResponse(response, locale) },
            { locale },
          ),
          components: [
            UI.row([
              UI.textInput({
                custom_id: 'rsvp_message',
                label: m.bot_rsvp_modal_label({}, { locale }),
                style: Discord.TextInputStyleTypes.PARAGRAPH,
                required,
                ...(required ? { min_length: 1 } : {}),
                max_length: 200,
              }),
            ]),
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
      return Effect.as(
        Effect.forkDetach(
          clearAndFollowUp.pipe(
            withBackstop(rest, interaction, locale, 'rsvp-clear: unexpected failure'),
          ),
        ),
        deferred,
      );
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
        Effect.catchTag('RsvpMessageRequired', () =>
          Effect.succeed({
            _tag: 'error' as const,
            hasMessage: false,
            content: m.bot_rsvp_message_required({}, { locale }),
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
      return Effect.as(
        Effect.forkDetach(
          submitAndFollowUp.pipe(
            withBackstop(rest, interaction, locale, 'rsvp-submit: unexpected failure'),
          ),
        ),
        deferred,
      );
    }),
    Effect.withSpan('interaction/rsvp-modal'),
  ),
);
