import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildClaimMessage } from '~/rest/events/buildClaimMessage.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);

export const handleTrainingClaimUpdate = (event: EventRpcEvents.TrainingClaimUpdateEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rest }) => {
      if (Option.isNone(event.claim_discord_message_id)) {
        return Effect.logWarning(
          `handleTrainingClaimUpdate: no claim_discord_message_id for event ${event.event_id}, skipping`,
        );
      }
      if (Option.isNone(event.claim_discord_channel_id)) {
        return Effect.logWarning(
          `handleTrainingClaimUpdate: no claim_discord_channel_id for event ${event.event_id}, skipping`,
        );
      }

      const channelId = event.claim_discord_channel_id.value;
      const messageId = event.claim_discord_message_id.value;

      return rest.getGuild(event.guild_id).pipe(
        Effect.map(decodeGuild),
        Effect.flatMap((guild) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });

          const claimedBy = Option.as(event.claimed_by_member_id, {
            discord_id: event.claimed_by_discord_id,
            name: event.claimed_by_name,
            nickname: event.claimed_by_nickname,
            display_name: event.claimed_by_display_name,
            username: event.claimed_by_username,
          });

          const payload = buildClaimMessage({
            title: event.title,
            startAt: event.start_at,
            endAt: event.end_at,
            location: event.location,
            locationUrl: event.location_url,
            description: event.description,
            claimedBy,
            eventStatus: event.event_status,
            teamId: event.team_id,
            eventId: event.event_id,
            locale,
            allDay: event.all_day,
          });

          return rest
            .updateMessage(channelId, messageId, {
              embeds: payload.embeds,
              components: payload.components,
            })
            .pipe(
              Effect.tap(() =>
                Effect.logInfo(
                  `Updated claim message for event ${event.event_id} in channel ${channelId}`,
                ),
              ),
              Effect.asVoid,
              Effect.catchTag('ErrorResponse', (err) =>
                err.response.status === 404
                  ? Effect.logWarning(
                      `handleTrainingClaimUpdate: claim message not found (404) for event ${event.event_id}, skipping`,
                    )
                  : Effect.fail(err),
              ),
            );
        }),
      );
    }),
  );
