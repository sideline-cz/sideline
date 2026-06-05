import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildEventEmbed, YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { reorderChannelMessages } from './reorderChannelMessages.js';

export const handleUpdated = (event: EventRpcEvents.EventUpdatedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('stored', ({ rpc }) =>
      rpc['Event/GetDiscordMessageId']({ event_id: event.event_id }),
    ),
    Effect.bind('guild', ({ rest }) => rest.getGuild(event.guild_id)),
    Effect.flatMap(({ rpc, rest, stored, guild }) =>
      Option.match(stored, {
        onNone: () =>
          Effect.logWarning(
            `No Discord message stored for event ${event.event_id}, skipping update`,
          ),
        onSome: (msg) =>
          Effect.all({
            counts: rpc['Event/GetRsvpCounts']({ event_id: event.event_id }),
            yesAttendees: rpc['Event/GetYesAttendeesForEmbed']({
              event_id: event.event_id,
              limit: YES_EMBED_LIMIT,
              member_group_id: Option.none(),
            }),
          }).pipe(
            Effect.flatMap(({ counts, yesAttendees }) => {
              const locale = guildLocale({ guild_locale: guild.preferred_locale });
              const payload = buildEventEmbed({
                teamId: event.team_id,
                eventId: event.event_id,
                title: event.title,
                description: event.description,
                imageUrl: event.image_url,
                startAt: event.start_at,
                endAt: event.end_at,
                location: event.location,
                locationUrl: event.location_url,
                eventType: event.event_type,
                counts,
                yesAttendees,
                locale,
                allDay: event.all_day,
              });
              return rest.updateMessage(msg.discord_channel_id, msg.discord_message_id, {
                embeds: payload.embeds,
                components: payload.components,
              });
            }),
            Effect.tap(() =>
              Effect.logInfo(
                `Updated event message for "${event.title}" in channel ${msg.discord_channel_id}`,
              ),
            ),
            Effect.tap(() =>
              reorderChannelMessages(
                msg.discord_channel_id,
                guildLocale({ guild_locale: guild.preferred_locale }),
              ),
            ),
            Effect.asVoid,
          ),
      }),
    ),
  );
