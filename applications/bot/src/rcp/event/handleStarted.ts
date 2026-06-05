import { Discord, type EventRpcEvents, type EventRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Option, pipe, Schema } from 'effect';
import type { Locale } from '~/locale.js';
import { guildLocale } from '~/locale.js';
import { buildEventEmbed, YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { locationDisplay } from '~/rest/events/locationDisplay.js';
import { formatNameWithMention, splitIntoFieldChunks } from '~/rest/utils.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { reorderChannelMessages } from './reorderChannelMessages.js';

const STARTED_POST_COLOR = 0xfee75c; // yellow

const toDiscordTimestamp = (dt: DateTime.Utc, style: 'F' | 'R' | 'f' = 'F'): string =>
  `<t:${Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000)}:${style}>`;

const parseGuild = (raw: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(DfxGuild)(raw),
    catch: () => new Error('Failed to decode guild'),
  });

export const handleStarted = (event: EventRpcEvents.EventStartedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('stored', ({ rpc }) =>
      rpc['Event/GetDiscordMessageId']({ event_id: event.event_id }),
    ),
    Effect.flatMap(({ rpc, rest, stored }) => {
      // In-place edit of existing embed — guild fetch failure falls back to default locale
      const inPlaceEdit = Option.match(stored, {
        onNone: () =>
          Effect.logWarning(
            `No Discord message stored for event ${event.event_id}, skipping started`,
          ),
        onSome: (msg) =>
          Effect.Do.pipe(
            Effect.bind('locale', () =>
              rest.getGuild(event.guild_id).pipe(
                Effect.flatMap(parseGuild),
                Effect.map((g) => guildLocale({ guild_locale: g.preferred_locale })),
                Effect.catch(() => Effect.succeed<Locale>('en')),
              ),
            ),
            Effect.bind('counts', () => rpc['Event/GetRsvpCounts']({ event_id: event.event_id })),
            Effect.bind('embedInfo', () =>
              rpc['Event/GetEventEmbedInfo']({ event_id: event.event_id }),
            ),
            Effect.bind('yesAttendees', () =>
              rpc['Event/GetYesAttendeesForEmbed']({
                event_id: event.event_id,
                limit: YES_EMBED_LIMIT,
                member_group_id: Option.none(),
              }),
            ),
            Effect.flatMap(({ locale, counts, embedInfo, yesAttendees }) =>
              Option.match(embedInfo, {
                onNone: () =>
                  Effect.logWarning(
                    `Event ${event.event_id} not found when building started embed`,
                  ),
                onSome: (info) => {
                  const payload = buildEventEmbed({
                    teamId: event.team_id,
                    eventId: event.event_id,
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
                    isStarted: true,
                    allDay: info.all_day,
                  });
                  return rest
                    .updateMessage(msg.discord_channel_id, msg.discord_message_id, {
                      embeds: payload.embeds,
                      components: payload.components,
                    })
                    .pipe(
                      Effect.tap(() =>
                        Effect.logInfo(
                          `Marked event ${event.event_id} as started in channel ${msg.discord_channel_id}`,
                        ),
                      ),
                      Effect.asVoid,
                      Effect.catchTag('ErrorResponse', (err) =>
                        err.data.code === 10008 // Unknown Message — message was deleted
                          ? rest
                              .createMessage(msg.discord_channel_id, {
                                embeds: payload.embeds,
                                components: payload.components,
                              })
                              .pipe(
                                Effect.flatMap((newMsg) =>
                                  Schema.decodeEffect(Discord.Snowflake)(newMsg.id),
                                ),
                                Effect.tap((newId) =>
                                  rpc['Event/SaveDiscordMessageId']({
                                    event_id: event.event_id,
                                    discord_channel_id: msg.discord_channel_id,
                                    discord_message_id: newId,
                                  }),
                                ),
                                Effect.tap((newId) =>
                                  Effect.logInfo(
                                    `Recreated missing started message for event ${event.event_id} in channel ${msg.discord_channel_id}, new id ${newId}`,
                                  ),
                                ),
                                Effect.asVoid,
                              )
                          : Effect.fail(err),
                      ),
                      Effect.tap(() => reorderChannelMessages(msg.discord_channel_id, locale)),
                    );
                },
              }),
            ),
            Effect.asVoid,
          ),
      });

      // New "Starting now" post — only fetches guild when discord_channel_id is absent
      const newPost = Effect.Do.pipe(
        Effect.bind('guildOpt', () =>
          Option.isNone(event.discord_channel_id)
            ? rest.getGuild(event.guild_id).pipe(
                Effect.flatMap(parseGuild),
                Effect.map(
                  (g) => Option.some(g) as Option.Option<Schema.Schema.Type<typeof DfxGuild>>,
                ),
                Effect.catch((e) =>
                  Effect.logWarning(
                    `handleStarted: failed to fetch guild for "Starting now" post, skipping`,
                    e,
                  ).pipe(
                    Effect.as(Option.none() as Option.Option<Schema.Schema.Type<typeof DfxGuild>>),
                  ),
                ),
              )
            : Effect.succeed(Option.none() as Option.Option<Schema.Schema.Type<typeof DfxGuild>>),
        ),
        Effect.flatMap(({ guildOpt }) => {
          const channelId = Option.getOrUndefined(
            Option.orElse(event.discord_channel_id, () =>
              Option.flatMap(guildOpt, (g) => g.system_channel_id),
            ),
          );

          if (!channelId) {
            return Effect.logWarning(
              `Guild ${event.guild_id} has no channel for "Starting now" post, skipping`,
            );
          }

          const locale: Locale = guildLocale({
            guild_locale: Option.match(guildOpt, {
              onSome: (g) => g.preferred_locale,
              onNone: () => 'en-US',
            }),
          });

          return rpc['Event/GetYesAttendeesForEmbed']({
            event_id: event.event_id,
            limit: YES_EMBED_LIMIT,
            member_group_id: event.member_group_id,
          }).pipe(
            Effect.flatMap((yesAttendees: ReadonlyArray<EventRpcModels.RsvpAttendeeEntry>) => {
              const nameFieldChunks = (entries: ReadonlyArray<string>, fieldName: string) =>
                splitIntoFieldChunks(entries).map((value) => ({
                  name: fieldName,
                  value,
                  inline: false,
                }));

              const yesAttendeeNames = pipe(yesAttendees, Array.map(formatNameWithMention));

              const descParts: string[] = [`${toDiscordTimestamp(event.start_at, 'F')}`];
              Option.match(locationDisplay(event.location, event.location_url), {
                onNone: () => undefined,
                onSome: (loc) => descParts.push(loc),
              });

              const fields = [
                ...nameFieldChunks(
                  yesAttendeeNames,
                  m.bot_event_started_post_attendees({}, { locale }),
                ),
              ];

              const roleMention = Option.match(event.discord_role_id, {
                onNone: () =>
                  ({}) as {
                    content?: string;
                    allowed_mentions?: { parse: []; roles: string[] };
                  },
                onSome: (role) => ({
                  content: `<@&${role}>`,
                  allowed_mentions: { parse: [] as [], roles: [role] },
                }),
              });

              return rest
                .createMessage(channelId, {
                  ...roleMention,
                  embeds: [
                    {
                      title: m.bot_event_started_post_title({ title: event.title }, { locale }),
                      color: STARTED_POST_COLOR,
                      description: descParts.join('\n'),
                      fields,
                    },
                  ],
                })
                .pipe(
                  Effect.tap((msg: { id: string }) =>
                    Effect.logInfo(
                      `Posted "Starting now" for "${event.title}" to channel ${channelId}, message ${msg.id}`,
                    ),
                  ),
                  Effect.asVoid,
                );
            }),
          );
        }),
      );

      const safeInPlaceEdit = Effect.exit(inPlaceEdit).pipe(
        Effect.tap((exit) =>
          exit._tag === 'Failure'
            ? Effect.logWarning('handleStarted: in-place edit failed', exit.cause)
            : Effect.void,
        ),
      );

      const safeNewPost = Effect.exit(newPost).pipe(
        Effect.tap((exit) =>
          exit._tag === 'Failure'
            ? Effect.logWarning('handleStarted: new post failed', exit.cause)
            : Effect.void,
        ),
      );

      return Effect.all([safeInPlaceEdit, safeNewPost], { concurrency: 'unbounded' }).pipe(
        Effect.asVoid,
      );
    }),
  );
