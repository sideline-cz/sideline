import { Discord, type EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildJoinBoardMessage } from '~/rest/events/buildJoinBoardMessage.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);
const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

export const handleTournamentJoinRequest = (event: EventRpcEvents.TournamentJoinRequestEvent) =>
  Option.match(event.join_request_discord_channel_id, {
    onNone: () =>
      Effect.logWarning(
        `handleTournamentJoinRequest: no channel resolved for event ${event.event_id}, skipping`,
      ),
    onSome: (channelId) =>
      Effect.Do.pipe(
        Effect.bind('rpc', () => SyncRpc.asEffect()),
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.bind('guild', ({ rest }) =>
          rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild)),
        ),
        Effect.flatMap(({ rpc, rest, guild }) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });

          const entry = {
            request_id: event.join_request_id,
            event_id: event.event_id,
            team_id: event.team_id,
            member_display_name: event.requester_display_name,
            member_discord_id: event.requester_discord_id,
            status: 'pending' as const,
            decided_by_display_name: Option.none(),
          };

          const payload = buildJoinBoardMessage({
            mode: 'review',
            entry,
            teamId: event.team_id,
            locale,
          });

          // Post the review message best-effort for Discord API failures (rate-limits, etc.).
          // S8: SaveJoinRequestMessageId failure is NOT swallowed — it propagates so the sync
          // event is retried and the message id is eventually persisted.
          return rest
            .createMessage(channelId, {
              embeds: payload.embeds,
              components: payload.components,
              allowed_mentions: { parse: [] as const },
            })
            .pipe(
              Effect.flatMap((msg) =>
                rpc['Event/SaveJoinRequestMessageId']({
                  request_id: event.join_request_id,
                  channel_id: channelId,
                  message_id: decodeSnowflake(msg.id),
                }),
              ),
              Effect.tap(() =>
                Effect.logInfo(
                  `Posted join request review message for event ${event.event_id} in channel ${channelId}`,
                ),
              ),
              Effect.asVoid,
              Effect.catchTag('ErrorResponse', (err) =>
                err.response.status === 404
                  ? Effect.logWarning(
                      `handleTournamentJoinRequest: channel not found (404) for event ${event.event_id}, skipping`,
                    )
                  : Effect.fail(err),
              ),
              Effect.catchTag(['HttpClientError', 'RatelimitedResponse'], (cause) =>
                Effect.logWarning(
                  `handleTournamentJoinRequest: Discord API error for event ${event.event_id}`,
                  cause,
                ),
              ),
            );
        }),
      ),
  });
