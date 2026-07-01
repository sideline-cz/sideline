import { Discord as DiscordSchema, type EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale, type Locale } from '~/locale.js';
import { buildEventEmbed, YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { reorderChannelMessages, safeDeleteMessage } from './reorderChannelMessages.js';

const decodeGuild = Schema.decodeUnknownEffect(DfxGuild);
const decodeSnowflake = Schema.decodeEffect(DiscordSchema.Snowflake);

export const handleChannelMoved = (event: EventRpcEvents.EventChannelMovedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    // Step 1: Resolve locale, falling back gracefully if getGuild fails
    Effect.bind('locale', ({ rest }) =>
      rest.getGuild(event.guild_id).pipe(
        Effect.flatMap(decodeGuild),
        Effect.map((g) => guildLocale({ guild_locale: g.preferred_locale })),
        Effect.tapError((e) =>
          Effect.logWarning('Failed to resolve guild locale, falling back to en', e),
        ),
        Effect.catch(() => Effect.succeed<Locale>('en')),
      ),
    ),
    // Step 2: Atomic repoint — commit point for crash-idempotency
    Effect.bind('moved', ({ rpc }) =>
      rpc['Event/RepointChannelEvents']({
        team_id: event.team_id,
        old_channel_id: event.old_channel_id,
        new_channel_id: event.new_channel_id,
      }),
    ),
    Effect.flatMap(({ rpc, rest, locale, moved }) =>
      Effect.Do.pipe(
        // Step 3: Delete old messages (cross-channel; only if old_channel_id is Some)
        Effect.tap(() =>
          Option.match(event.old_channel_id, {
            onNone: () => Effect.void,
            onSome: (oldChannel) =>
              Effect.forEach(
                moved.filter((row) => Option.isSome(row.old_message_id)),
                (row) =>
                  Option.match(row.old_message_id, {
                    onNone: () => Effect.void,
                    onSome: (mid) =>
                      // Swallow Discord code 10008 ("Unknown Message") — safeDeleteMessage does this
                      safeDeleteMessage(
                        oldChannel,
                        mid,
                        `Failed to delete old message ${mid} from channel ${oldChannel} for event ${row.event_id}`,
                      ),
                  }),
                { concurrency: 3 },
              ).pipe(Effect.asVoid),
          }),
        ),
        // Step 4: Post all unposted events into new channel (only if new_channel_id is Some)
        // Driven off durable DB state (events with NULL discord_message_id in new channel),
        // so retries recover correctly and no slot cap is needed here.
        Effect.tap(() =>
          Option.match(event.new_channel_id, {
            onNone: () => Effect.void,
            onSome: (newChannel) =>
              rpc['Event/GetUnpostedUpcomingByChannel']({ discord_channel_id: newChannel }).pipe(
                Effect.flatMap((toPost) =>
                  Effect.forEach(
                    toPost,
                    (event_id) =>
                      Effect.Do.pipe(
                        Effect.bind('embedInfo', () =>
                          rpc['Event/GetEventEmbedInfo']({ event_id }),
                        ),
                        Effect.flatMap(({ embedInfo }) =>
                          Option.match(embedInfo, {
                            // Event vanished/cancelled between repoint and post — skip
                            onNone: () =>
                              Effect.logInfo(
                                `Event ${event_id} no longer exists, skipping post to channel ${newChannel}`,
                              ),
                            onSome: (info) =>
                              Effect.Do.pipe(
                                Effect.bind('counts', () =>
                                  rpc['Event/GetRsvpCounts']({ event_id }),
                                ),
                                Effect.bind('yesAttendees', () =>
                                  rpc['Event/GetYesAttendeesForEmbed']({
                                    event_id,
                                    limit: YES_EMBED_LIMIT,
                                    member_group_id: Option.none(),
                                  }),
                                ),
                                Effect.flatMap(({ counts, yesAttendees }) => {
                                  const payload = buildEventEmbed({
                                    teamId: event.team_id,
                                    eventId: event_id,
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
                                    locale,
                                    allDay: info.all_day,
                                  });
                                  return rest
                                    .createMessage(newChannel, {
                                      embeds: payload.embeds,
                                      components: payload.components,
                                    })
                                    .pipe(
                                      Effect.flatMap((msg) => decodeSnowflake(msg.id)),
                                      Effect.flatMap((discord_message_id) =>
                                        rpc['Event/SaveDiscordMessageId']({
                                          event_id,
                                          discord_channel_id: newChannel,
                                          discord_message_id,
                                        }),
                                      ),
                                      Effect.tap(() =>
                                        Effect.logInfo(
                                          `Posted moved event ${event_id} to new channel ${newChannel}`,
                                        ),
                                      ),
                                      Effect.asVoid,
                                    );
                                }),
                              ),
                          }),
                        ),
                      ),
                    { concurrency: 1 },
                  ).pipe(Effect.asVoid),
                ),
              ),
          }),
        ),
        // Step 5: Finalize new channel
        Effect.tap(() =>
          Option.match(event.new_channel_id, {
            onNone: () => Effect.void,
            onSome: (newChannel) => reorderChannelMessages(newChannel, locale),
          }),
        ),
        // Step 6: Clean old channel
        Effect.tap(() =>
          Option.match(event.old_channel_id, {
            onNone: () => Effect.void,
            onSome: (oldChannel) => reorderChannelMessages(oldChannel, locale),
          }),
        ),
        Effect.asVoid,
      ),
    ),
  );
