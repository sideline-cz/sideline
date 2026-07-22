import { createHash } from 'node:crypto';
import {
  Discord as DiscordSchemas,
  type Event,
  type EventRpcModels,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, Effect, Option, Schedule, Schema } from 'effect';
import { guildLocale, type Locale } from '~/locale.js';
import type { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { buildEventEmbed, YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { buildPersonalMessage } from '~/rest/events/buildPersonalEventMessage.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { reorderPersonalChannel } from './reorderPersonalChannel.js';

/** Stable hash of a raw (possibly response-typed) Discord message payload. */
const hashPayload = (payload: unknown): string =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

type GuildLocaleShape = {
  readonly preferred_locale: string;
  readonly system_channel_id: Option.Option<DiscordSchemas.Snowflake>;
};
const tryDecodeGuild = (raw: unknown): GuildLocaleShape => {
  try {
    return Schema.decodeUnknownSync(DfxGuild)(raw);
  } catch {
    return { preferred_locale: 'en-US', system_channel_id: Option.none() };
  }
};

type PersonalChannelMember = {
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly discord_id: DiscordSchemas.Snowflake;
  readonly personal_channel_id: DiscordSchemas.Snowflake;
};

type SyncRest = SyncRpc | DiscordREST;

/**
 * Reconcile one event's message in a single member's personal channel.
 *
 * Returns `Some(member)` when a NEW message was created (the channel may now be
 * out of order and needs a reorder pass); `None` for in-place edits, no-ops, or
 * deletions (which never break ordering).
 */
const reconcileMemberMessage = (params: {
  event: { event_id: Event.EventId; guild_id: DiscordSchemas.Snowflake };
  member: PersonalChannelMember;
  yesAttendees: ReadonlyArray<EventRpcModels.RsvpAttendeeEntry>;
  locale: Locale;
}): Effect.Effect<Option.Option<PersonalChannelMember>, never, SyncRest> => {
  const { event, member, yesAttendees, locale } = params;
  return Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('events', ({ rpc }) =>
      rpc['Guild/GetAllUpcomingEventsForUser']({
        guild_id: event.guild_id,
        discord_user_id: member.discord_id,
      }).pipe(
        Effect.catchTag('RsvpMemberNotFound', () =>
          Effect.succeed({ events: [], total: 0, team_id: '' }),
        ),
        Effect.catchTag('GuildNotFound', () =>
          Effect.succeed({ events: [], total: 0, team_id: '' }),
        ),
      ),
    ),
    Effect.bind('stored', ({ rpc }) =>
      rpc['PersonalEvents/GetPersonalEventMessage']({
        event_id: event.event_id,
        team_member_id: member.team_member_id,
      }),
    ),
    Effect.flatMap(({ rpc, rest, events: userResult, stored }) => {
      const entry = userResult.events.find((e) => e.event_id === event.event_id);

      // Event is no longer in the member's upcoming window (cancelled / passed /
      // group filtered): delete the stale Discord message and its row, if any.
      if (entry === undefined) {
        if (Option.isNone(stored)) {
          return Effect.succeed(Option.none<PersonalChannelMember>());
        }
        return rest.deleteMessage(member.personal_channel_id, stored.value.discord_message_id).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(
            rpc['PersonalEvents/DeletePersonalEventMessage']({
              event_id: event.event_id,
              team_member_id: member.team_member_id,
            }).pipe(Effect.catchTag('RpcClientError', () => Effect.void)),
          ),
          Effect.as(Option.none<PersonalChannelMember>()),
        );
      }

      const render = buildPersonalMessage({
        entry,
        yesAttendees,
        discordId: member.discord_id,
        locale,
      });
      const hash = render.hash;

      const storedHash = Option.isSome(stored) ? stored.value.payload_hash : null;
      if (storedHash === hash) {
        return Effect.succeed(Option.none<PersonalChannelMember>());
      }

      if (Option.isSome(stored)) {
        // Update existing message in place — ordering is unaffected. Editing the
        // message (rather than creating) means an unanswered-event mention in
        // editPayload registers + highlights but never pings.
        const messageId = stored.value.discord_message_id;
        return rest.updateMessage(member.personal_channel_id, messageId, render.editPayload).pipe(
          Effect.tap(() =>
            rpc['PersonalEvents/UpsertPersonalEventMessage']({
              event_id: event.event_id,
              team_member_id: member.team_member_id,
              personal_channel_id: member.personal_channel_id,
              discord_message_id: messageId,
              payload_hash: hash,
            }).pipe(
              Effect.catchTag('RpcClientError', (e) =>
                Effect.logWarning(
                  `Failed to upsert personal event message for member ${member.team_member_id}`,
                  e,
                ),
              ),
            ),
          ),
          Effect.as(Option.none<PersonalChannelMember>()),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
            Effect.logWarning(
              `Failed to update personal channel message for member ${member.team_member_id}`,
              e,
            ).pipe(Effect.as(Option.none<PersonalChannelMember>())),
          ),
        );
      }

      // No stored message — CREATE it (new member or new event). A create appends
      // at the bottom, so the channel may need a reorder afterwards → return Some.
      // We always create mention-free, then add an unanswered-event mention via an
      // edit so it highlights the message without pinging the member.
      // Dedup safety: if the persist fails after retries, delete the just-created
      // Discord message (compensating action) and propagate so the event stays dirty.
      const upsertRetryPolicy = Schedule.exponential('200 millis').pipe(
        Schedule.both(Schedule.recurs(3)),
      );
      const persist = (discordMessageId: DiscordSchemas.Snowflake, payloadHash: string) =>
        rpc['PersonalEvents/UpsertPersonalEventMessage']({
          event_id: event.event_id,
          team_member_id: member.team_member_id,
          personal_channel_id: member.personal_channel_id,
          discord_message_id: discordMessageId,
          payload_hash: payloadHash,
        }).pipe(
          Effect.retry(upsertRetryPolicy),
          Effect.catchTag('RpcClientError', (rpcErr) =>
            rest.deleteMessage(member.personal_channel_id, discordMessageId).pipe(
              Effect.catchCause((deleteCause) =>
                Effect.logWarning(
                  `Compensating delete failed for orphan message ${discordMessageId} (member ${member.team_member_id})`,
                  deleteCause,
                ),
              ),
              Effect.andThen(Effect.fail(rpcErr)),
            ),
          ),
        );
      return rest.createMessage(member.personal_channel_id, render.createPayload).pipe(
        Effect.flatMap((msg) => {
          const discordMessageId = DiscordSchemas.Snowflake.makeUnsafe(msg.id);
          const logCreated = Effect.logInfo(
            `Created personal event message ${discordMessageId} for member ${member.team_member_id} event ${event.event_id}`,
          );
          if (!render.needsMentionEdit) {
            return persist(discordMessageId, hash).pipe(Effect.tap(() => logCreated));
          }
          // Add the mention via edit (no ping). On failure, persist '' so the next
          // reconcile re-applies it; on success persist the final hash.
          return rest
            .updateMessage(member.personal_channel_id, discordMessageId, render.editPayload)
            .pipe(
              Effect.matchEffect({
                onSuccess: () => persist(discordMessageId, hash),
                onFailure: (e) =>
                  Effect.logWarning(
                    `Failed to apply mention edit for member ${member.team_member_id}`,
                    e,
                  ).pipe(Effect.andThen(persist(discordMessageId, ''))),
              }),
              Effect.tap(() => logCreated),
            );
        }),
        Effect.as(Option.some(member)),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
          Effect.logWarning(
            `Failed to create personal channel message for member ${member.team_member_id}`,
            e,
          ).pipe(Effect.as(Option.none<PersonalChannelMember>())),
        ),
        Effect.catchTag('RpcClientError', () =>
          Effect.succeed(Option.none<PersonalChannelMember>()),
        ),
      );
    }),
    Effect.catchTag('RpcClientError', (e) =>
      Effect.logWarning(
        `RPC error reconciling personal channel for member ${member.team_member_id}`,
        e,
      ).pipe(Effect.as(Option.none<PersonalChannelMember>())),
    ),
  );
};

export const reconcileEvent = (event: {
  event_id: Event.EventId;
  team_id: Team.TeamId;
  guild_id: DiscordSchemas.Snowflake;
}): Effect.Effect<void, never, SyncRpc | DiscordREST | ChannelReorderSemaphore> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    // Get guild for locale
    Effect.bind('guild', ({ rest }) =>
      rest.getGuild(event.guild_id).pipe(
        Effect.map((raw): GuildLocaleShape => tryDecodeGuild(raw)),
        Effect.catch(
          (): Effect.Effect<GuildLocaleShape> =>
            Effect.succeed({
              preferred_locale: 'en-US',
              system_channel_id: Option.none<DiscordSchemas.Snowflake>(),
            }),
        ),
      ),
    ),
    Effect.let('locale', ({ guild }) => guildLocale({ guild_locale: guild.preferred_locale })),
    // 1. Personal channel reconcile: list personal channels for this event
    Effect.bind('personalChannels', ({ rpc }) =>
      rpc['Guild/ListPersonalChannelsForEvent']({ event_id: event.event_id }).pipe(
        Effect.catchTag('RpcClientError', (e) =>
          Effect.logWarning(
            `RPC error listing personal channels for event ${event.event_id}`,
            e,
          ).pipe(Effect.map((): ReadonlyArray<PersonalChannelMember> => [])),
        ),
      ),
    ),
    // Fetch the yes-attendees once per event — shared across every member's embed.
    Effect.bind('yesAttendees', ({ rpc }) =>
      rpc['Event/GetYesAttendeesForEmbed']({
        event_id: event.event_id,
        limit: YES_EMBED_LIMIT,
        member_group_id: Option.none(),
      }).pipe(
        Effect.catchTag('RpcClientError', (e) =>
          Effect.logWarning(`RPC error fetching yes attendees for event ${event.event_id}`, e).pipe(
            Effect.map((): ReadonlyArray<EventRpcModels.RsvpAttendeeEntry> => []),
          ),
        ),
      ),
    ),
    // 2. For each member: reconcile their personal message; collect those whose
    //    channel got a new message (and thus may need reordering).
    Effect.bind('reorderTargets', ({ personalChannels, yesAttendees, locale }) =>
      Effect.forEach(
        personalChannels,
        (member) => reconcileMemberMessage({ event, member, yesAttendees, locale }),
        { concurrency: 1 },
      ).pipe(Effect.map(Arr.getSomes)),
    ),
    // 3. Reorder the touched personal channels so they match the global ordering.
    Effect.tap(({ reorderTargets, locale }) =>
      Effect.forEach(
        reorderTargets,
        (member) =>
          reorderPersonalChannel({
            team_member_id: member.team_member_id,
            discord_id: member.discord_id,
            guild_id: event.guild_id,
            locale,
          }),
        { concurrency: 1 },
      ),
    ),
    // 4. NB-A1: Also refresh the global shared message (hash-diff to avoid unnecessary API calls)
    Effect.bind('globalMsg', ({ rpc }) =>
      rpc['Event/GetDiscordMessageId']({ event_id: event.event_id }).pipe(
        Effect.catchTag('RpcClientError', (e) =>
          Effect.logWarning(
            `RPC error getting discord message id for event ${event.event_id}`,
            e,
          ).pipe(
            Effect.map(
              (): Option.Option<{
                discord_channel_id: DiscordSchemas.Snowflake;
                discord_message_id: DiscordSchemas.Snowflake;
              }> => Option.none(),
            ),
          ),
        ),
      ),
    ),
    Effect.flatMap(({ rpc, rest, globalMsg, locale }) =>
      Option.match(globalMsg, {
        onNone: () => Effect.void,
        onSome: (msg) =>
          Effect.Do.pipe(
            Effect.bind('embedInfo', () =>
              rpc['Event/GetEventEmbedInfo']({ event_id: event.event_id }),
            ),
            Effect.flatMap(({ embedInfo }) =>
              Option.match(embedInfo, {
                onNone: () => Effect.void,
                onSome: (info) => {
                  // Non-active events (started/cancelled) have their global message
                  // owned by handleStarted/handleCancelled. Refreshing it here would
                  // revert the started/cancelled styling (and re-add RSVP buttons).
                  if (info.status !== 'active') {
                    return Effect.logDebug(
                      `Skipping global message refresh for non-active event ${event.event_id} (status ${info.status})`,
                    );
                  }
                  return Effect.all({
                    counts: rpc['Event/GetRsvpCounts']({ event_id: event.event_id }),
                    yesAttendees: rpc['Event/GetYesAttendeesForEmbed']({
                      event_id: event.event_id,
                      limit: YES_EMBED_LIMIT,
                      member_group_id: Option.none(),
                    }),
                  }).pipe(
                    Effect.flatMap(({ counts, yesAttendees }) => {
                      const embed = buildEventEmbed({
                        teamId: String(event.team_id),
                        eventId: String(event.event_id),
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
                      const payload = {
                        embeds: embed.embeds,
                        components: embed.components,
                        allowed_mentions: { parse: [] as [] },
                      };

                      // Hash-diff: fetch current stored hash from the message or compute
                      const newHash = hashPayload({
                        embeds: payload.embeds,
                        components: payload.components,
                      });

                      // Check if the global message content changed by fetching it.
                      return rest.getMessage(msg.discord_channel_id, msg.discord_message_id).pipe(
                        Effect.flatMap((currentMsg) => {
                          const currentHash = hashPayload({
                            embeds: currentMsg.embeds ?? [],
                            components: currentMsg.components ?? [],
                          });
                          if (currentHash === newHash) {
                            return Effect.void;
                          }
                          return rest
                            .updateMessage(msg.discord_channel_id, msg.discord_message_id, payload)
                            .pipe(
                              Effect.tap(() =>
                                Effect.logInfo(
                                  `Reconciled global message for event ${event.event_id} in channel ${msg.discord_channel_id}`,
                                ),
                              ),
                              Effect.asVoid,
                            );
                        }),
                        Effect.catchTag(
                          ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                          (_e) =>
                            // If fetching fails, fall back to always updating
                            rest
                              .updateMessage(
                                msg.discord_channel_id,
                                msg.discord_message_id,
                                payload,
                              )
                              .pipe(
                                Effect.tap(() =>
                                  Effect.logInfo(
                                    `Reconciled global message for event ${event.event_id} (fallback, no hash diff)`,
                                  ),
                                ),
                                Effect.asVoid,
                              ),
                        ),
                      );
                    }),
                    Effect.catchTag(
                      ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                      (e) =>
                        Effect.logWarning(
                          `Failed to update global event message for event ${event.event_id}`,
                          e,
                        ),
                    ),
                  );
                },
              }),
            ),
            Effect.catchTag('RpcClientError', (e) =>
              Effect.logWarning(`RPC error refreshing global event message ${event.event_id}`, e),
            ),
          ),
      }),
    ),
    Effect.asVoid,
  );
