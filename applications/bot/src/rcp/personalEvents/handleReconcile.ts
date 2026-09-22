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
import { isUnknownMessageError } from '~/rest/discordErrors.js';
import { buildPersonalMessage } from '~/rest/events/buildPersonalEventMessage.js';
import { retryPolicy, YES_EMBED_LIMIT } from '~/rest/utils.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { reorderPersonalChannel } from './reorderPersonalChannel.js';

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
          Effect.succeed({ events: [], total: 0, team_id: '', show_attendee_list: true }),
        ),
        Effect.catchTag('GuildNotFound', () =>
          Effect.succeed({ events: [], total: 0, team_id: '', show_attendee_list: true }),
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
        return Effect.logInfo(
          `Deleting personal event message ${stored.value.discord_message_id} for member ${member.team_member_id} — event ${event.event_id} left the member's upcoming window`,
        ).pipe(
          Effect.andThen(
            // Address the channel the message actually lives in, not the member's
            // CURRENT channel — `event_type` is mutable, so a bucket move can leave
            // those two values pointing at different channels (plan §7.4/B4).
            rest
              .deleteMessage(stored.value.personal_channel_id, stored.value.discord_message_id)
              // Retry for the same reason as the bucket-move delete below: the row is
              // dropped straight after, so a swallowed transient failure orphans the
              // message in a channel nothing will ever look at again.
              .pipe(Effect.retry(retryPolicy)),
          ),
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
        // Setting 1 (plan §7.4): hide the attendee names, not the turnout — the
        // RSVPs counts field and the Attendees button both stay regardless.
        yesAttendees: userResult.show_attendee_list ? yesAttendees : [],
        discordId: member.discord_id,
        locale,
      });
      const hash = render.hash;

      const storedHash = Option.isSome(stored) ? stored.value.payload_hash : null;

      // CREATE the message (new member, new event, or a stored row whose Discord
      // message has since been deleted). A create appends at the bottom, so the
      // channel may need a reorder afterwards → return Some.
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
      const createFlow = () =>
        rest.createMessage(member.personal_channel_id, render.createPayload).pipe(
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

      // Bucket move (event_type edited, or the member switched one↔three, plan §7.4/B4):
      // the STORED message lives in a different channel than the member's CURRENT one.
      // Must precede the hash skip below — the payload is usually unchanged across a
      // move, so the skip would otherwise strand the card in the old channel forever.
      if (Option.isSome(stored)) {
        const storedChannelId = stored.value.personal_channel_id;
        const storedMessageId = stored.value.discord_message_id;
        if (storedChannelId !== member.personal_channel_id) {
          // CREATE FIRST, then delete the old message. createFlow swallows Discord
          // failures into Option.none and ProcessorService clears the dirty flag
          // regardless, so delete-then-create would leave the member with NO card on
          // a transient 429/5xx. Create-then-delete degrades to a duplicate instead.
          //
          // The delete MUST retry. Once createFlow succeeds the row points at the NEW
          // channel, so the next pass sees storedChannelId === member.personal_channel_id,
          // takes no move branch, matches the hash and skips — nothing ever revisits the
          // old channel, and reorderPersonalChannel only knows DB-tracked messages. A
          // single swallowed 429 would therefore strand a live, fully interactive card in
          // the member's old bucket channel permanently, not transiently.
          return createFlow().pipe(
            Effect.tap((created) =>
              Option.isSome(created)
                ? rest.deleteMessage(storedChannelId, storedMessageId).pipe(
                    Effect.retry(retryPolicy),
                    Effect.catch(() => Effect.void),
                  )
                : Effect.void,
            ),
          );
        }
      }

      if (storedHash === hash) {
        return Effect.succeed(Option.none<PersonalChannelMember>());
      }

      if (Option.isNone(stored)) {
        return createFlow();
      }

      // Update existing message in place — ordering is unaffected. Editing the
      // message (rather than creating) means an unanswered-event mention in
      // editPayload registers + highlights but never pings.
      const messageId = stored.value.discord_message_id;
      return rest
        .updateMessage(stored.value.personal_channel_id, messageId, render.editPayload)
        .pipe(
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
            // The row points at a message Discord no longer has — someone deleted it
            // by hand, or a reorder's delete-then-recreate raced us. Without this
            // branch the row survives forever, every later pass re-PATCHes the same
            // dead id, and the member's card is gone for good (it is never recreated,
            // because `stored` keeps insisting it exists).
            //
            // Post a fresh message and let `persist`'s upsert (ON CONFLICT
            // (event_id, team_member_id) DO UPDATE) repoint the row. Deliberately NOT
            // deleting the row first: that would open a window where a create failure
            // (rate limit, 5xx) leaves the member with no message AND no row, while
            // the processor clears the dirty flag regardless — the "live event, zero
            // cards, nothing left to retry" state seen in production.
            isUnknownMessageError(e)
              ? Effect.logWarning(
                  `Personal event message ${messageId} is gone from Discord (member ${member.team_member_id}, event ${event.event_id}) — recreating`,
                ).pipe(Effect.andThen(createFlow()))
              : Effect.logWarning(
                  `Failed to update personal channel message for member ${member.team_member_id}`,
                  e,
                ).pipe(Effect.as(Option.none<PersonalChannelMember>())),
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
    Effect.asVoid,
  );
