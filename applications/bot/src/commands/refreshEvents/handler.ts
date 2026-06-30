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
 * `/refresh-events` — admin (ManageEvents) command. Run inside an events channel
 * to re-sync it. Classifies the current channel via `Guild/IdentifyEventsChannel`:
 * the global events channel → `reorderChannelMessages` (re-renders in place +
 * reorders); the caller's own personal channel → mark the team's events dirty
 * (content re-render via the reconcile loop) + `reorderPersonalChannel`. The
 * heavy work is forked so the interaction gets its 3s ack; channel content
 * renders in the guild locale, the ephemeral reply in the caller's locale.
 */
export const refreshEventsHandler = Interaction.asEffect().pipe(
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
            if (identified.kind === 'global') {
              return Effect.forkDetach(
                reorderChannelMessages(snowflakeChannelId, channelLocale),
              ).pipe(Effect.as(ephemeral(m.bot_refresh_events_global({}, { locale }))));
            }
            if (
              identified.kind === 'personal' &&
              Option.isSome(identified.team_id) &&
              Option.isSome(identified.team_member_id)
            ) {
              const teamId = identified.team_id.value;
              const teamMemberId = identified.team_member_id.value;
              const work = rpc['Guild/MarkTeamPersonalEventsDirty']({ team_id: teamId }).pipe(
                Effect.catchTag('RpcClientError', (e) =>
                  Effect.logWarning('refresh-events: failed to mark events dirty', e),
                ),
                Effect.andThen(
                  reorderPersonalChannel({
                    team_member_id: teamMemberId,
                    discord_id: userId,
                    guild_id: snowflakeGuildId,
                    locale: channelLocale,
                  }),
                ),
              );
              return Effect.forkDetach(work).pipe(
                Effect.as(ephemeral(m.bot_refresh_events_personal({}, { locale }))),
              );
            }
            return Effect.succeed(ephemeral(m.bot_refresh_events_none({}, { locale })));
          }),
          Effect.catchTag('RpcClientError', (e) =>
            Effect.logWarning('refresh-events: IdentifyEventsChannel failed', e).pipe(
              Effect.as(ephemeral(m.bot_refresh_events_none({}, { locale }))),
            ),
          ),
        ),
      ),
    );
  }),
  Effect.withSpan('command/refresh-events'),
);
