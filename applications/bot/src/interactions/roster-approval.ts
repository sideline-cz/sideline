import { Discord as DiscordSchemas, Event, TeamMember } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Option, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeEventId = Schema.decodeUnknownSync(Event.EventId);
const decodeMemberId = Schema.decodeUnknownSync(TeamMember.TeamMemberId);

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

const buildDisabledRosterRow = (
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
): Discord.ActionRowComponentForMessageRequest =>
  UI.row([
    UI.button({
      style: 3, // style 3 = Success
      label: m.bot_roster_btn_approve({}, { locale: 'en' }),
      custom_id: `rsv-approve:${eventId}:${memberId}`,
      disabled: true,
    }),
    UI.button({
      style: 4, // style 4 = Danger
      label: m.bot_roster_btn_decline({}, { locale: 'en' }),
      custom_id: `rsv-decline:${eventId}:${memberId}`,
      disabled: true,
    }),
  ]);

const makeApproveAndFollowUp = (
  rpc: typeof SyncRpc.Service,
  rest: DiscordRestService,
  interaction: Discord.APIInteraction,
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
  discordUserId: DiscordSchemas.Snowflake,
) => {
  const locale = userLocale(interaction);
  const channelId = interaction.channel_id;
  const messageId = interaction.message?.id;

  const disableSource =
    channelId !== undefined && messageId !== undefined
      ? rest
          .updateMessage(channelId, messageId, {
            components: [buildDisabledRosterRow(eventId, memberId)],
            allowed_mentions: { parse: [] },
          })
          .pipe(
            Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (err) =>
              Effect.logWarning(
                `RosterApproveButton: failed to disable buttons on message ${messageId}`,
                err,
              ),
            ),
            Effect.asVoid,
          )
      : Effect.void;

  return rpc['Event/ApproveRosterRequest']({
    event_id: eventId,
    team_member_id: memberId,
    decided_by_discord_id: discordUserId,
  }).pipe(
    Effect.flatMap(({ outcome, member_display_name }) => {
      if (outcome === 'already_handled' || outcome === 'already_member') {
        return editFollowUp(
          rest,
          interaction,
          m.bot_roster_ephemeral_already_handled({}, { locale }),
        );
      }
      const candidate = Option.getOrElse(member_display_name, () => '?');
      return Effect.all([
        editFollowUp(rest, interaction, m.bot_roster_ephemeral_approved({ candidate }, { locale })),
        disableSource,
      ]).pipe(Effect.asVoid);
    }),
    Effect.catchTag('NotOwnerGroupMember', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_not_owner({}, { locale })),
    ),
    Effect.catchTag('RosterRequestNotPending', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_already_handled({}, { locale })),
    ),
    Effect.catchTag('RosterRequestNotFound', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_error({}, { locale })),
    ),
    Effect.catchTag('EventRosterEventNotFound', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_error({}, { locale })),
    ),
    Effect.catchTag('RpcClientError', (error) =>
      Effect.logError('RosterApproveButton: RPC error', error),
    ),
    Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
      Effect.logError('RosterApproveButton: failed to update follow-up', error),
    ),
  );
};

const makeDeclineAndFollowUp = (
  rpc: typeof SyncRpc.Service,
  rest: DiscordRestService,
  interaction: Discord.APIInteraction,
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
  discordUserId: DiscordSchemas.Snowflake,
) => {
  const locale = userLocale(interaction);
  const channelId = interaction.channel_id;
  const messageId = interaction.message?.id;

  const disableSource =
    channelId !== undefined && messageId !== undefined
      ? rest
          .updateMessage(channelId, messageId, {
            components: [buildDisabledRosterRow(eventId, memberId)],
            allowed_mentions: { parse: [] },
          })
          .pipe(
            Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (err) =>
              Effect.logWarning(
                `RosterDeclineButton: failed to disable buttons on message ${messageId}`,
                err,
              ),
            ),
            Effect.asVoid,
          )
      : Effect.void;

  return rpc['Event/DeclineRosterRequest']({
    event_id: eventId,
    team_member_id: memberId,
    decided_by_discord_id: discordUserId,
  }).pipe(
    Effect.flatMap(({ outcome, member_display_name: _memberDisplayName }) => {
      if (outcome === 'already_handled' || outcome === 'already_member') {
        return editFollowUp(
          rest,
          interaction,
          m.bot_roster_ephemeral_already_handled({}, { locale }),
        );
      }
      return Effect.all([
        editFollowUp(rest, interaction, m.bot_roster_ephemeral_declined({}, { locale })),
        disableSource,
      ]).pipe(Effect.asVoid);
    }),
    Effect.catchTag('NotOwnerGroupMember', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_not_owner({}, { locale })),
    ),
    Effect.catchTag('RosterRequestNotPending', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_already_handled({}, { locale })),
    ),
    Effect.catchTag('RosterRequestNotFound', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_error({}, { locale })),
    ),
    Effect.catchTag('EventRosterEventNotFound', () =>
      editFollowUp(rest, interaction, m.bot_roster_ephemeral_error({}, { locale })),
    ),
    Effect.catchTag('RpcClientError', (error) =>
      Effect.logError('RosterDeclineButton: RPC error', error),
    ),
    Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
      Effect.logError('RosterDeclineButton: failed to update follow-up', error),
    ),
  );
};

const rosterButtonEffect = (
  makeFollowUp: (
    rpc: typeof SyncRpc.Service,
    rest: DiscordRestService,
    interaction: Discord.APIInteraction,
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    discordUserId: DiscordSchemas.Snowflake,
  ) => Effect.Effect<void, never, never>,
) =>
  Effect.Do.pipe(
    Effect.bind('data', () => MessageComponentData.asEffect()),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ data, interaction, rpc, rest }) => {
      // custom_id format: rsv-approve:<eventId>:<memberId>
      const parts = data.custom_id.split(':');
      const eventId = decodeEventId(parts[1]);
      const memberId = decodeMemberId(parts[2]);
      const discordUserIdOption = interactionUserId(interaction);

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };

      if (Option.isNone(discordUserIdOption)) {
        return Effect.succeed(deferred);
      }

      const discordUserId = decodeSnowflake(discordUserIdOption.value);
      const followUp = makeFollowUp(rpc, rest, interaction, eventId, memberId, discordUserId);
      return Effect.as(Effect.forkDetach(followUp), deferred);
    }),
  );

export const RosterApproveButton = Ix.messageComponent(
  Ix.idStartsWith('rsv-approve:'),
  rosterButtonEffect(makeApproveAndFollowUp).pipe(
    Effect.withSpan('interaction/roster-approve-button'),
  ),
);

export const RosterDeclineButton = Ix.messageComponent(
  Ix.idStartsWith('rsv-decline:'),
  rosterButtonEffect(makeDeclineAndFollowUp).pipe(
    Effect.withSpan('interaction/roster-decline-button'),
  ),
);
