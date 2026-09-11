import type { EventRpcEvents, EventRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Option, pipe, Schema } from 'effect';
import type { Locale } from '~/locale.js';
import { guildLocale } from '~/locale.js';
import { YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { formatEventWhenLong } from '~/rest/events/eventWhen.js';
import { locationDisplay } from '~/rest/events/locationDisplay.js';
import { formatNameWithMention, splitIntoFieldChunks } from '~/rest/utils.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const STARTED_POST_COLOR = 0xfee75c; // yellow

const parseGuild = (raw: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(DfxGuild)(raw),
    catch: () => new Error('Failed to decode guild'),
  });

export const handleStarted = (event: EventRpcEvents.EventStartedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rpc, rest }) => {
      // New "Starting now" post — only fetches guild when discord_channel_id is absent
      const newPost = Effect.Do.pipe(
        Effect.bind('guildOpt', () =>
          Option.isNone(event.discord_channel_id)
            ? rest.getGuild(event.guild_id).pipe(
                Effect.flatMap(parseGuild),
                Effect.map(
                  (g): Option.Option<Schema.Schema.Type<typeof DfxGuild>> => Option.some(g),
                ),
                Effect.catch((e) =>
                  Effect.logWarning(
                    `handleStarted: failed to fetch guild for "Starting now" post, skipping`,
                    e,
                  ).pipe(Effect.as(Option.none<Schema.Schema.Type<typeof DfxGuild>>())),
                ),
              )
            : Effect.succeed(Option.none<Schema.Schema.Type<typeof DfxGuild>>()),
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

              const descParts: string[] = [
                formatEventWhenLong({
                  startAt: event.start_at,
                  // ⚠ the all-day branch takes DATES, not instants (§11.4 of the plan). This
                  // supplies the UTC date of the (still noon-anchored) instant, which is correct
                  // under the current storage anchor; a later change replaces it with the
                  // payload's real `start_date`. `DateTime.formatIsoDateUtc` is the repo idiom
                  // outside the web (api/event-series.ts:117, EventHorizonCron.ts:39) — do NOT
                  // reach for `formatUtcDate`, which lives in applications/web only.
                  startDate: DateTime.formatIsoDateUtc(event.start_at),
                  endAt: event.end_at,
                  endDate: Option.map(event.end_at, DateTime.formatIsoDateUtc),
                  allDay: event.all_day,
                  locale,
                }),
              ];
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

              const roleMention: {
                content?: string;
                allowed_mentions?: {
                  parse: [];
                  roles?: string[];
                  users?: string[];
                };
              } =
                event.event_type === 'training'
                  ? Option.match(event.claimed_by_discord_id, {
                      onSome: (coachId) => ({
                        content: `<@${coachId}>`,
                        allowed_mentions: { parse: [] as const, users: [coachId] },
                      }),
                      onNone: () =>
                        Option.match(event.discord_role_id, {
                          onSome: (ownersRole) => ({
                            content: `<@&${ownersRole}> ${m.bot_event_started_no_coach_warning({}, { locale })}`,
                            allowed_mentions: { parse: [] as const, roles: [ownersRole] },
                          }),
                          onNone: () => ({
                            content: m.bot_event_started_no_coach_warning({}, { locale }),
                          }),
                        }),
                    })
                  : Option.match(event.discord_role_id, {
                      onNone: () => ({}),
                      onSome: (role) => ({
                        content: `<@&${role}>`,
                        allowed_mentions: { parse: [] as const, roles: [role] },
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

      const safeNewPost = Effect.exit(newPost).pipe(
        Effect.tap((exit) =>
          exit._tag === 'Failure'
            ? Effect.logWarning('handleStarted: new post failed', exit.cause)
            : Effect.void,
        ),
      );

      // Best-effort: delete the owners-thread claim message when the training starts
      const deleteClaim =
        event.event_type === 'training'
          ? rpc['Event/GetClaimInfo']({ event_id: event.event_id }).pipe(
              Effect.flatMap((claimOpt) =>
                Option.match(
                  Option.flatMap(claimOpt, (claim) =>
                    Option.all([claim.claim_discord_channel_id, claim.claim_discord_message_id]),
                  ),
                  {
                    onNone: () => Effect.void,
                    onSome: ([threadId, msgId]) =>
                      rest.deleteMessage(threadId, msgId).pipe(
                        Effect.asVoid,
                        Effect.catchTag('ErrorResponse', (err) =>
                          err.data.code === 10008
                            ? Effect.void
                            : Effect.logWarning(
                                `handleStarted: deleteMessage failed for claim of event ${event.event_id}`,
                                err,
                              ),
                        ),
                      ),
                  },
                ),
              ),
            )
          : Effect.void;

      const safeDeleteClaim = Effect.exit(deleteClaim).pipe(
        Effect.tap((exit) =>
          exit._tag === 'Failure'
            ? Effect.logWarning('handleStarted: delete claim failed', exit.cause)
            : Effect.void,
        ),
      );

      return Effect.all([safeNewPost, safeDeleteClaim], {
        concurrency: 'unbounded',
      }).pipe(Effect.asVoid);
    }),
  );
