import { Discord, type EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildEventEmbed, YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { reorderChannelMessages } from './reorderChannelMessages.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);
const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

export const handleCreated = (event: EventRpcEvents.EventCreatedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rpc, rest }) => {
      // If no global events channel is configured, skip (no system_channel fallback).
      if (Option.isNone(event.discord_channel_id)) {
        return Effect.logInfo(
          `No global events channel configured for guild ${event.guild_id}, skipping event post for "${event.title}"`,
        );
      }

      const channelId = event.discord_channel_id.value;

      return Effect.Do.pipe(
        Effect.bind('counts', () => rpc['Event/GetRsvpCounts']({ event_id: event.event_id })),
        Effect.bind('yesAttendees', () =>
          rpc['Event/GetYesAttendeesForEmbed']({
            event_id: event.event_id,
            limit: YES_EMBED_LIMIT,
            member_group_id: Option.none(),
          }),
        ),
        Effect.bind('guild', () => rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild))),
        Effect.flatMap(({ counts, yesAttendees, guild }) => {
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
          return rest
            .createMessage(channelId, {
              embeds: payload.embeds,
              components: payload.components,
            })
            .pipe(
              Effect.tap((msg) =>
                rpc['Event/SaveDiscordMessageId']({
                  event_id: event.event_id,
                  discord_channel_id: channelId,
                  discord_message_id: decodeSnowflake(msg.id),
                }),
              ),
              Effect.tap((msg) =>
                Effect.logInfo(
                  `Posted event "${event.title}" to channel ${channelId}, message ${msg.id}`,
                ),
              ),
              Effect.tap(() => reorderChannelMessages(channelId, locale)),
              Effect.asVoid,
            );
        }),
      );
    }),
  );
