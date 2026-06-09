import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildJoinBoardMessage } from '~/rest/events/buildJoinBoardMessage.js';
import { DfxGuild } from '~/schemas.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);

export const handleTournamentAttendanceUpdate = (
  event: EventRpcEvents.TournamentAttendanceUpdateEvent,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rest }) => {
      if (Option.isNone(event.join_request_discord_message_id)) {
        return Effect.logWarning(
          `handleTournamentAttendanceUpdate: no join_request_discord_message_id for request ${event.join_request_id}, skipping`,
        );
      }
      if (Option.isNone(event.join_request_discord_channel_id)) {
        return Effect.logWarning(
          `handleTournamentAttendanceUpdate: no join_request_discord_channel_id for request ${event.join_request_id}, skipping`,
        );
      }

      const channelId = event.join_request_discord_channel_id.value;
      const messageId = event.join_request_discord_message_id.value;

      return rest.getGuild(event.guild_id).pipe(
        Effect.map(decodeGuild),
        Effect.flatMap((guild) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });

          const entry = {
            request_id: event.join_request_id,
            event_id: event.event_id,
            team_id: event.team_id,
            member_display_name: event.requester_display_name,
            member_discord_id: Option.none<string>(),
            // status is now typed as JoinRequestStatus (accepted|declined|pending)
            status: event.status,
            decided_by_display_name: event.decided_by_display_name,
          };

          const payload = buildJoinBoardMessage({
            mode: 'review',
            entry,
            teamId: event.team_id,
            locale,
          });

          return rest
            .updateMessage(channelId, messageId, {
              embeds: payload.embeds,
              components: payload.components,
              allowed_mentions: { parse: [] as const },
            })
            .pipe(
              Effect.tap(() =>
                Effect.logInfo(
                  `Updated join request message for request ${event.join_request_id} in channel ${channelId}`,
                ),
              ),
              Effect.asVoid,
              Effect.catchTag('ErrorResponse', (err) =>
                err.response.status === 404
                  ? Effect.logWarning(
                      `handleTournamentAttendanceUpdate: message not found (404) for request ${event.join_request_id}, skipping`,
                    )
                  : Effect.fail(err),
              ),
              Effect.catchTag(['HttpClientError', 'RatelimitedResponse'], (cause) =>
                Effect.logWarning(
                  `handleTournamentAttendanceUpdate: Discord API error for request ${event.join_request_id}`,
                  cause,
                ),
              ),
            );
        }),
      );
    }),
  );
