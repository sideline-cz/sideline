import {
  type Discord,
  Discord as DiscordSchema,
  Event,
  type EventRpcModels,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import type * as DiscordTypes from 'dfx/types';
import { Array as Arr, DateTime, Effect, Option, Order, Schema } from 'effect';
import type { Locale } from '~/locale.js';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import {
  buildCancelledEmbed,
  buildEventEmbed,
  YES_EMBED_LIMIT,
} from '~/rest/events/buildEventEmbed.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const MAX_CHANNEL_EVENTS = 10;

const decodeSnowflake = Schema.decodeEffect(DiscordSchema.Snowflake);

/** Compare two snowflakes numerically via BigInt. Returns -1, 0, or 1. */
export const compareSnowflakes = (a: Discord.Snowflake, b: Discord.Snowflake): number => {
  const ai = BigInt(a);
  const bi = BigInt(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
};

/** EditOutcome: result of attempting an in-place edit. */
type EditOutcome = 'edited' | 'message_gone';

/**
 * Internal payload type that extends MessageCreateRequest to allow _testEventId
 * for test mock identification. The extra field is ignored by real Discord REST.
 */
type EventMessagePayload = {
  readonly embeds: ReadonlyArray<DiscordTypes.RichEmbed>;
  readonly components: ReadonlyArray<DiscordTypes.ActionRowComponentForMessageRequest>;
  readonly _testEventId?: string;
};

/** Build the message payload for an event entry (live counts + yes attendees). */
const buildEventPayload = (
  entry: EventRpcModels.ChannelEventEntry,
  counts: EventRpcModels.RsvpCountsResult,
  yesAttendees: ReadonlyArray<EventRpcModels.RsvpAttendeeEntry>,
  locale: Locale,
): EventMessagePayload => {
  const base =
    entry.status === 'cancelled'
      ? buildCancelledEmbed(entry.title, locale)
      : buildEventEmbed({
          teamId: entry.team_id,
          eventId: entry.event_id,
          title: entry.title,
          description: entry.description,
          imageUrl: entry.image_url,
          startAt: entry.start_at,
          endAt: entry.end_at,
          location: entry.location,
          locationUrl: entry.location_url,
          eventType: entry.event_type,
          counts,
          yesAttendees,
          locale,
          isStarted: entry.status === 'started',
          allDay: entry.all_day,
        });
  return { embeds: base.embeds, components: base.components, _testEventId: entry.event_id };
};

/** Fetch the live data needed to build an event payload. */
const loadEventPayload = (
  entry: EventRpcModels.ChannelEventEntry,
  locale: Locale,
): Effect.Effect<EventMessagePayload, unknown, SyncRpc> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('counts', ({ rpc }) =>
      rpc['Event/GetRsvpCounts']({ event_id: Event.EventId.makeUnsafe(entry.event_id) }),
    ),
    Effect.bind('yesAttendees', ({ rpc }) =>
      rpc['Event/GetYesAttendeesForEmbed']({
        event_id: Event.EventId.makeUnsafe(entry.event_id),
        limit: YES_EMBED_LIMIT,
        member_group_id: Option.none(),
      }),
    ),
    Effect.map(({ counts, yesAttendees }) =>
      buildEventPayload(entry, counts, yesAttendees, locale),
    ),
  );

/** Delete a Discord message, logging and swallowing any REST error. */
const safeDeleteMessage = (
  channelId: Discord.Snowflake,
  messageId: Discord.Snowflake,
  warnContext: string,
): Effect.Effect<void, never, DiscordREST> =>
  DiscordREST.asEffect().pipe(
    Effect.flatMap((rest) => rest.deleteMessage(channelId, messageId)),
    Effect.tapError((e) => Effect.logWarning(warnContext, e)),
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );

/** Attempt to edit an existing event message in-place. */
const editMessageInPlace = (
  channelId: Discord.Snowflake,
  targetMessageId: Discord.Snowflake,
  entry: EventRpcModels.ChannelEventEntry,
  locale: Locale,
): Effect.Effect<EditOutcome, never, SyncRpc | DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('payload', () => loadEventPayload(entry, locale)),
    Effect.flatMap(({ rest, payload }) =>
      rest.updateMessage(channelId, targetMessageId, payload).pipe(
        Effect.as<EditOutcome>('edited'),
        Effect.catchTag('ErrorResponse', (err) =>
          err.data.code === 10008 ? Effect.succeed<EditOutcome>('message_gone') : Effect.fail(err),
        ),
      ),
    ),
    Effect.catch((e) =>
      Effect.logWarning(
        `Failed to edit event message ${targetMessageId} in channel ${channelId}`,
        e,
      ).pipe(Effect.as<EditOutcome>('edited')),
    ),
  );

/** Create a new event message and persist the new ID. */
const createEventMessage = (
  channelId: Discord.Snowflake,
  entry: EventRpcModels.ChannelEventEntry,
  locale: Locale,
): Effect.Effect<Discord.Snowflake, never, SyncRpc | DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('payload', () => loadEventPayload(entry, locale)),
    Effect.flatMap(({ rpc, rest, payload }) =>
      rest.createMessage(channelId, payload).pipe(
        Effect.flatMap((msg) => decodeSnowflake(msg.id)),
        Effect.tap((newId) =>
          rpc['Event/SaveDiscordMessageId']({
            event_id: Event.EventId.makeUnsafe(entry.event_id),
            discord_channel_id: channelId,
            discord_message_id: newId,
          }),
        ),
      ),
    ),
    Effect.catch(
      LogicError.withMessage(
        (e) =>
          `Failed to create event message for event ${entry.event_id} in channel ${channelId}: ${e}`,
      ),
    ),
  );

export const sortEntriesForChannel = (
  entries: ReadonlyArray<EventRpcModels.ChannelEventEntry>,
  now: DateTime.Utc,
): Array<EventRpcModels.ChannelEventEntry> =>
  Arr.sort(
    entries,
    Order.make<EventRpcModels.ChannelEventEntry>((a, b) => {
      const aIsPast = DateTime.isLessThan(a.start_at, now);
      const bIsPast = DateTime.isLessThan(b.start_at, now);
      if (aIsPast && !bIsPast) return -1;
      if (!aIsPast && bIsPast) return 1;
      const timeOrder =
        aIsPast && bIsPast
          ? DateTime.Order(a.start_at, b.start_at)
          : DateTime.Order(b.start_at, a.start_at);
      if (timeOrder !== 0) return timeOrder;
      return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
    }),
  );

const buildDividerEmbed = (
  locale: Locale,
): {
  embeds: ReadonlyArray<DiscordTypes.RichEmbed>;
  components: ReadonlyArray<DiscordTypes.ActionRowComponentForMessageRequest>;
} => ({
  embeds: [
    {
      description: m.bot_event_divider_past({}, { locale }),
      color: 0x2b2d31,
    },
  ],
  components: [],
});

/** An item in the reorder list: either an event entry or the divider. */
type ReorderItem =
  | {
      readonly _tag: 'event';
      readonly entry: EventRpcModels.ChannelEventEntry;
      /** Effective snowflake used by the prefix algorithm (may be None if overridden). */
      readonly snowflake: Option.Option<Discord.Snowflake>;
      /** Snowflake of the old Discord message to delete during recreation (if any). */
      readonly deleteSnowflake: Option.Option<Discord.Snowflake>;
    }
  | { readonly _tag: 'divider'; readonly snowflake: Option.Option<Discord.Snowflake> };

/**
 * Compute the longest keepable prefix length k.
 *
 * An item can be in the kept prefix if:
 * 1. Its snowflake is Some.
 * 2. Its snowflake is strictly greater than the previous kept item's snowflake.
 * 3. Its snowflake is strictly less than the minimum snowflake in the remaining suffix.
 */
export const longestKeepablePrefix = (
  items: ReadonlyArray<{ readonly snowflake: Option.Option<Discord.Snowflake> }>,
): number => {
  const n = items.length;
  // Build minSuffix[i] = minimum snowflake in items[i..n-1] (only counting Some snowflakes)
  const minSuffix: Array<Option.Option<Discord.Snowflake>> = new Array(n + 1);
  minSuffix[n] = Option.none();
  for (let i = n - 1; i >= 0; i--) {
    const itemSf = items[i].snowflake;
    const suffMin = minSuffix[i + 1];
    if (Option.isNone(itemSf)) {
      minSuffix[i] = suffMin;
    } else if (Option.isNone(suffMin)) {
      minSuffix[i] = itemSf;
    } else {
      minSuffix[i] = compareSnowflakes(itemSf.value, suffMin.value) <= 0 ? itemSf : suffMin;
    }
  }

  let k = 0;
  let lastKept: Option.Option<Discord.Snowflake> = Option.none();

  for (let i = 0; i < n; i++) {
    const sf = items[i].snowflake;
    // Must have a snowflake to be in kept prefix
    if (Option.isNone(sf)) break;
    // Must be strictly greater than last kept
    if (Option.isSome(lastKept) && compareSnowflakes(sf.value, lastKept.value) <= 0) break;
    // The minimum of the next suffix must be greater than this snowflake
    const nextMin = minSuffix[i + 1];
    if (Option.isSome(nextMin) && compareSnowflakes(nextMin.value, sf.value) <= 0) break;

    k = i + 1;
    lastKept = sf;
  }

  return k;
};

export const reorderChannelMessages = (
  channelId: Discord.Snowflake,
  locale: Locale,
  snowflakeOverrides?: ReadonlyMap<string, Option.Option<Discord.Snowflake>>,
): Effect.Effect<void, never, SyncRpc | DiscordREST | ChannelReorderSemaphore> => {
  const inner: Effect.Effect<void, unknown, SyncRpc | DiscordREST> = Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('entries', ({ rpc }) =>
      rpc['Event/GetChannelEvents']({ discord_channel_id: channelId }),
    ),
    Effect.bind('existingDivider', ({ rpc }) =>
      rpc['Event/GetChannelDivider']({ discord_channel_id: channelId }),
    ),
    Effect.flatMap(({ rpc, rest, entries, existingDivider }) => {
      // --- Empty entries: clean up divider if present ---
      if (Arr.isReadonlyArrayEmpty(entries)) {
        return Option.match(existingDivider, {
          onNone: () => Effect.void,
          onSome: (dividerId) =>
            safeDeleteMessage(
              channelId,
              dividerId,
              `Failed to delete divider message ${dividerId}`,
            ).pipe(
              Effect.tap(() =>
                rpc['Event/DeleteChannelDivider']({ discord_channel_id: channelId }),
              ),
              Effect.asVoid,
            ),
        });
      }

      const now = DateTime.nowUnsafe();
      const sortedEntries = sortEntriesForChannel(entries, now);

      // --- Apply cap: keep last MAX_CHANNEL_EVENTS entries ---
      const dropCount = Math.max(0, sortedEntries.length - MAX_CHANNEL_EVENTS);
      const droppedEntries = sortedEntries.slice(0, dropCount);
      const cappedEntries = sortedEntries.slice(dropCount);

      const hasPast = Arr.some(cappedEntries, (e) => DateTime.isLessThan(e.start_at, now));
      const hasFuture = Arr.some(cappedEntries, (e) => !DateTime.isLessThan(e.start_at, now));
      const needsDivider = hasPast && hasFuture;

      // --- Delete cap-dropped messages ---
      const deleteDropped: Effect.Effect<void, never, DiscordREST> =
        droppedEntries.length === 0
          ? Effect.void
          : Effect.forEach(
              droppedEntries,
              (entry) =>
                safeDeleteMessage(
                  channelId,
                  entry.discord_message_id,
                  `Failed to delete cap-dropped message ${entry.discord_message_id}`,
                ),
              { concurrency: 3 },
            ).pipe(Effect.asVoid);

      // --- Divider lifecycle: delete unwanted divider BEFORE prefix algorithm ---
      const handleDividerDeletion: Effect.Effect<void, never, SyncRpc | DiscordREST> =
        !needsDivider && Option.isSome(existingDivider)
          ? safeDeleteMessage(
              channelId,
              existingDivider.value,
              `Failed to delete divider message ${existingDivider.value}`,
            ).pipe(
              Effect.tap(() =>
                rpc['Event/DeleteChannelDivider']({ discord_channel_id: channelId }).pipe(
                  Effect.catch(
                    LogicError.withMessage(
                      (e) =>
                        `Failed to delete channel divider record for channel ${channelId}: ${e}`,
                    ),
                  ),
                ),
              ),
              Effect.asVoid,
            )
          : Effect.void;

      return deleteDropped.pipe(
        Effect.flatMap(() => handleDividerDeletion),
        Effect.flatMap(() => {
          // --- Compute dividerInsertIndex ---
          const pastIndex = Arr.findLastIndex(cappedEntries, (e) =>
            DateTime.isLessThan(e.start_at, now),
          );
          const dividerInsertIndex = Option.match(pastIndex, {
            onNone: () => 0,
            onSome: (i) => i + 1,
          });

          // --- Build items array with snowflakes ---
          const eventItems: Array<ReorderItem> = cappedEntries.map((entry) => {
            // Apply snowflake override if present (used by startup recovery to force
            // recreation of messages that no longer exist on Discord).
            const override = snowflakeOverrides?.get(entry.event_id);
            const originalSnowflake = Option.some(entry.discord_message_id);
            const snowflake = override !== undefined ? override : originalSnowflake;
            // deleteSnowflake: always the DB-stored discord_message_id (to delete old message on recreation)
            return {
              _tag: 'event' as const,
              entry,
              snowflake,
              deleteSnowflake: originalSnowflake,
            };
          });

          const items: Array<ReorderItem> = needsDivider
            ? [
                ...eventItems.slice(0, dividerInsertIndex),
                { _tag: 'divider' as const, snowflake: existingDivider },
                ...eventItems.slice(dividerInsertIndex),
              ]
            : eventItems;

          // --- Prefix algorithm ---
          const k = longestKeepablePrefix(items);

          // --- Process kept prefix (in-place edits). Returns the actual k after
          // any message_gone failures (caller folds the rest into recreate). ---
          const processKeptPrefix: Effect.Effect<number, never, SyncRpc | DiscordREST> = (() => {
            const go = (i: number): Effect.Effect<number, never, SyncRpc | DiscordREST> => {
              if (i >= k) return Effect.succeed(k);
              const item = items[i];
              // Kept items always have Some snowflakes (guaranteed by longestKeepablePrefix)
              if (Option.isNone(item.snowflake)) return Effect.succeed(i);

              const snowflakeValue = item.snowflake.value;
              const editEffect: Effect.Effect<EditOutcome, never, SyncRpc | DiscordREST> =
                item._tag === 'divider'
                  ? rest.updateMessage(channelId, snowflakeValue, buildDividerEmbed(locale)).pipe(
                      Effect.as<EditOutcome>('edited'),
                      Effect.catchTag('ErrorResponse', (err) =>
                        err.data.code === 10008
                          ? Effect.succeed<EditOutcome>('message_gone')
                          : Effect.fail(err),
                      ),
                      Effect.catch((e) =>
                        Effect.logWarning(
                          `Failed to update divider message at ${snowflakeValue}`,
                          e,
                        ).pipe(Effect.as<EditOutcome>('edited')),
                      ),
                    )
                  : editMessageInPlace(channelId, snowflakeValue, item.entry, locale);

              return editEffect.pipe(
                Effect.flatMap((outcome) =>
                  // On 'message_gone': abort kept loop, return i as the new effective k
                  outcome === 'message_gone' ? Effect.succeed(i) : go(i + 1),
                ),
              );
            };
            return go(0);
          })();

          return processKeptPrefix.pipe(
            Effect.flatMap((effectiveK) => {
              // Items from effectiveK onward need recreation
              const recreateItems = items.slice(effectiveK);

              if (recreateItems.length === 0) {
                return Effect.logInfo(
                  `Reordered ${items.length} message(s) in channel ${channelId}`,
                );
              }

              // Recreate sequentially (concurrency: 1) to ensure monotonic snowflakes
              return Effect.forEach(
                recreateItems,
                (item) => {
                  // For events use deleteSnowflake (preserves original DB message ID
                  // even when snowflakeOverride=None); for dividers use snowflake.
                  const oldMsgId = item._tag === 'event' ? item.deleteSnowflake : item.snowflake;
                  const deleteOld: Effect.Effect<void, never, DiscordREST> = Option.match(
                    oldMsgId,
                    {
                      onNone: () => Effect.void,
                      onSome: (oldId) =>
                        safeDeleteMessage(
                          channelId,
                          oldId,
                          `Failed to delete old message ${oldId}`,
                        ),
                    },
                  );

                  const recreate: Effect.Effect<void, never, SyncRpc | DiscordREST> =
                    item._tag === 'divider'
                      ? rest.createMessage(channelId, buildDividerEmbed(locale)).pipe(
                          Effect.flatMap((msg) => decodeSnowflake(msg.id)),
                          Effect.tap((newId) =>
                            rpc['Event/SaveChannelDivider']({
                              discord_channel_id: channelId,
                              discord_message_id: newId,
                            }),
                          ),
                          Effect.catch(
                            LogicError.withMessage(
                              (e) =>
                                `Failed to create divider message in channel ${channelId}: ${e}`,
                            ),
                          ),
                          Effect.asVoid,
                        )
                      : createEventMessage(channelId, item.entry, locale).pipe(Effect.asVoid);

                  return deleteOld.pipe(Effect.flatMap(() => recreate));
                },
                { concurrency: 1 },
              ).pipe(
                Effect.tap(() =>
                  Effect.logInfo(`Reordered ${items.length} message(s) in channel ${channelId}`),
                ),
                Effect.asVoid,
              );
            }),
          );
        }),
      );
    }),
  );

  return ChannelReorderSemaphore.asEffect().pipe(
    Effect.flatMap((semaphoreService) =>
      semaphoreService
        .withChannelLock(channelId)(inner)
        .pipe(
          Effect.catch(
            LogicError.withMessage(
              (e) => `Unexpected error during channel reorder for channel ${channelId}: ${e}`,
            ),
          ),
        ),
    ),
  );
};
