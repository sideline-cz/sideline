import { Discord } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option } from 'effect';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { reorderChannelMessages } from '~/rcp/event/reorderChannelMessages.js';
import { reorderPersonalChannel } from '~/rcp/personalEvents/reorderPersonalChannel.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const ephemeral = (content: string) =>
  Ix.response({
    type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: DiscordTypes.MessageFlags.Ephemeral },
  });

/**
 * `/event refresh` — re-sync the events channel it's run in. The subcommand is
 * visible to everyone under `/event`; access is gated at runtime (NOT via Discord
 * permissions) by `Guild/IdentifyEventsChannel`, which classifies the current
 * channel and returns the personal channel's owner plus the caller's admin status:
 *  - own personal channel → anyone may refresh;
 *  - another member's personal channel → Sideline admins (`team:manage`) only;
 *  - the team's global events channel → admins only.
 * The heavy refresh is forked so the interaction is acked within 3s. Global →
 * reorderChannelMessages (re-render in place + reorder); a personal channel →
 * MarkTeamPersonalEventsDirty (content re-render via reconcile) + reorderPersonalChannel,
 * acting with the channel OWNER's identity (so an admin refresh renders the owner's events).
 */
export const refreshHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const channelLocale = guildLocale(interaction);
    const guildId = interaction.guild_id;
    const channelId = interaction.channel_id;
    const maybeUserId = interactionUserId(interaction);

    if (!guildId || !channelId || Option.isNone(maybeUserId)) {
      return Effect.succeed(ephemeral(m.bot_refresh_events_none({}, { locale })));
    }
    const userId = maybeUserId.value;
    const snowflakeGuildId = Discord.Snowflake.makeUnsafe(guildId);
    const snowflakeChannelId = Discord.Snowflake.makeUnsafe(channelId);

    return SyncRpc.asEffect().pipe(
      Effect.flatMap((rpc) =>
        rpc['Guild/IdentifyEventsChannel']({
          guild_id: snowflakeGuildId,
          channel_id: snowflakeChannelId,
          discord_user_id: userId,
        }).pipe(
          Effect.flatMap((identified) => {
            // A personal channel: anyone may refresh their OWN; refreshing another
            // member's requires admin. Act with the channel owner's identity.
            if (
              identified.kind === 'personal' &&
              Option.isSome(identified.team_id) &&
              Option.isSome(identified.team_member_id) &&
              Option.isSome(identified.owner_discord_id)
            ) {
              const isOwnChannel = identified.owner_discord_id.value === userId;
              if (!isOwnChannel && !identified.is_admin) {
                return Effect.succeed(ephemeral(m.bot_refresh_events_forbidden({}, { locale })));
              }
              const teamId = identified.team_id.value;
              const teamMemberId = identified.team_member_id.value;
              const ownerDiscordId = identified.owner_discord_id.value;
              const work = rpc['Guild/MarkTeamPersonalEventsDirty']({ team_id: teamId }).pipe(
                Effect.catchTag('RpcClientError', (e) =>
                  Effect.logWarning('event refresh: failed to mark events dirty', e),
                ),
                Effect.andThen(
                  reorderPersonalChannel({
                    team_member_id: teamMemberId,
                    discord_id: ownerDiscordId,
                    guild_id: snowflakeGuildId,
                    locale: channelLocale,
                  }),
                ),
              );
              return Effect.forkDetach(work).pipe(
                Effect.as(ephemeral(m.bot_refresh_events_personal({}, { locale }))),
              );
            }
            // The global events channel: admins only.
            if (identified.kind === 'global') {
              if (!identified.is_admin) {
                return Effect.succeed(ephemeral(m.bot_refresh_events_forbidden({}, { locale })));
              }
              return Effect.forkDetach(
                reorderChannelMessages(snowflakeChannelId, channelLocale),
              ).pipe(Effect.as(ephemeral(m.bot_refresh_events_global({}, { locale }))));
            }
            return Effect.succeed(ephemeral(m.bot_refresh_events_none({}, { locale })));
          }),
          Effect.catchTag('RpcClientError', (e) =>
            Effect.logWarning('event refresh: IdentifyEventsChannel failed', e).pipe(
              Effect.as(ephemeral(m.bot_refresh_events_none({}, { locale }))),
            ),
          ),
        ),
      ),
    );
  }),
  Effect.withSpan('command/event.refresh'),
);
