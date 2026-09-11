import {
  Discord as DiscordSchemas,
  type Event,
  type EventRpcModels,
  type TeamMember,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, DateTime, Effect, Option, Order } from 'effect';
import type { Locale } from '~/locale.js';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { longestKeepablePrefix } from '~/rcp/event/channelReorderPrefix.js';
import { YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { buildPersonalMessage } from '~/rest/events/buildPersonalEventMessage.js';
import { SyncRpc } from '~/services/SyncRpc.js';

type MemberMessage = {
  readonly event_id: Event.EventId;
  readonly personal_channel_id: DiscordSchemas.Snowflake;
  readonly discord_message_id: DiscordSchemas.Snowflake;
  readonly start_at: DateTime.Utc;
  readonly all_day: boolean;
  readonly local_date: string;
};

/**
 * Order a member's personal messages the same way the other ascending surfaces are
 * ordered (dashboard, `/event upcoming`, guild event list — see `eventDayOrder` on the
 * server, plan §4.7), but REVERSED: personal channels only contain future events, so
 * they sort latest-day-first — the soonest upcoming day ends up at the bottom, nearest
 * the input box.
 *
 * The canonical ascending key is `(local_date, all_day ? 0 : 1, start_at, event_id)` —
 * all-day events sort above that day's timed events, universal-calendar-convention
 * style. This is exactly that key, reversed component-by-component: `local_date`
 * descending, all-day LAST within its day (nearest the input box, the mirror image of
 * "above the timed grid"), `start_at` descending, `event_id` descending as the final
 * tiebreaker for two all-day events sharing the same date (they collide on every other
 * column — §4.4.3's pagination-tiebreaker hazard, applied here to the reorder's own
 * stability).
 *
 * Under the current (team-local-midnight) storage anchor, a same-day all-day event's
 * `start_at` is already the day's earliest instant, so the `start_at`-descending
 * component alone already places it last within its day for free — the `all_day`
 * component only matters as a deterministic override, and the `event_id` component only
 * matters when two all-day events land on the identical `start_at`.
 */
const desiredOrder = Order.make<MemberMessage>((a, b) => {
  if (a.local_date !== b.local_date) return a.local_date > b.local_date ? -1 : 1;
  if (a.all_day !== b.all_day) return a.all_day ? 1 : -1;
  const t = DateTime.Order(b.start_at, a.start_at);
  if (t !== 0) return t;
  return a.event_id > b.event_id ? -1 : a.event_id < b.event_id ? 1 : 0;
});

const reorderWithMessages = (
  params: {
    team_member_id: TeamMember.TeamMemberId;
    discord_id: DiscordSchemas.Snowflake;
    guild_id: DiscordSchemas.Snowflake;
    locale: Locale;
  },
  channelId: DiscordSchemas.Snowflake,
  messages: ReadonlyArray<MemberMessage>,
): Effect.Effect<void, unknown, SyncRpc | DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rpc, rest }) => {
      const sorted = Arr.sort(messages, desiredOrder);
      const items = sorted.map((m) => ({ snowflake: Option.some(m.discord_message_id) }));
      const recreate = sorted.slice(longestKeepablePrefix(items));
      if (recreate.length === 0) {
        return Effect.void;
      }

      // Load the member's upcoming events once so we can re-render the suffix.
      return rpc['Guild/GetAllUpcomingEventsForUser']({
        guild_id: params.guild_id,
        discord_user_id: params.discord_id,
      }).pipe(
        Effect.catchTag('RsvpMemberNotFound', () =>
          Effect.succeed({ events: [], total: 0, team_id: '' }),
        ),
        Effect.catchTag('GuildNotFound', () =>
          Effect.succeed({ events: [], total: 0, team_id: '' }),
        ),
        Effect.flatMap((userResult) => {
          const entryById = new Map<string, EventRpcModels.UpcomingEventForUserEntry>(
            userResult.events.map((e) => [e.event_id, e]),
          );
          // Recreate sequentially (concurrency 1) so new snowflakes stay monotonic.
          return Effect.forEach(
            recreate,
            (msg) => {
              const entry = entryById.get(msg.event_id);
              if (entry === undefined) {
                // Event vanished between the two queries — drop the stale message.
                return rest.deleteMessage(channelId, msg.discord_message_id).pipe(
                  Effect.tap(() =>
                    rpc['PersonalEvents/DeletePersonalEventMessage']({
                      event_id: msg.event_id,
                      team_member_id: params.team_member_id,
                    }).pipe(Effect.catchTag('RpcClientError', () => Effect.void)),
                  ),
                  Effect.catch(() => Effect.void),
                  Effect.asVoid,
                );
              }
              return rpc['Event/GetYesAttendeesForEmbed']({
                event_id: msg.event_id,
                limit: YES_EMBED_LIMIT,
                member_group_id: Option.none(),
              }).pipe(
                Effect.flatMap((yesAttendees) => {
                  const render = buildPersonalMessage({
                    entry,
                    yesAttendees,
                    discordId: params.discord_id,
                    locale: params.locale,
                  });
                  const persist = (
                    discordMessageId: DiscordSchemas.Snowflake,
                    payloadHash: string,
                  ) =>
                    rpc['PersonalEvents/UpsertPersonalEventMessage']({
                      event_id: msg.event_id,
                      team_member_id: params.team_member_id,
                      personal_channel_id: channelId,
                      discord_message_id: discordMessageId,
                      payload_hash: payloadHash,
                    });
                  // Delete the old (out-of-order) message, then recreate it at the end,
                  // mention-free, adding any unanswered-event mention via a follow-up edit.
                  return rest.deleteMessage(channelId, msg.discord_message_id).pipe(
                    Effect.catch(() => Effect.void),
                    Effect.andThen(rest.createMessage(channelId, render.createPayload)),
                    Effect.flatMap((created) => {
                      const id = DiscordSchemas.Snowflake.makeUnsafe(created.id);
                      if (!render.needsMentionEdit) {
                        return persist(id, render.hash);
                      }
                      return rest.updateMessage(channelId, id, render.editPayload).pipe(
                        Effect.matchEffect({
                          onSuccess: () => persist(id, render.hash),
                          onFailure: () => persist(id, ''),
                        }),
                      );
                    }),
                    Effect.asVoid,
                  );
                }),
                Effect.catchTag(
                  ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse', 'RpcClientError'],
                  (e) =>
                    Effect.logWarning(
                      `Failed to recreate personal message for event ${msg.event_id} (member ${params.team_member_id})`,
                      e,
                    ),
                ),
              );
            },
            { concurrency: 1 },
          ).pipe(
            Effect.tap(() =>
              Effect.logInfo(
                `Reordered ${recreate.length} personal message(s) in channel ${channelId}`,
              ),
            ),
            Effect.asVoid,
          );
        }),
      );
    }),
  );

/**
 * Reorder a single member's personal channel so its event messages match the
 * global ordering. Messages already in the correct relative (snowflake) order
 * are kept untouched; the out-of-order suffix is deleted and recreated in order.
 * Content refresh is the reconcile loop's job — this pass only fixes ordering.
 */
export const reorderPersonalChannel = (params: {
  team_member_id: TeamMember.TeamMemberId;
  discord_id: DiscordSchemas.Snowflake;
  guild_id: DiscordSchemas.Snowflake;
  locale: Locale;
}): Effect.Effect<void, never, SyncRpc | DiscordREST | ChannelReorderSemaphore> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('semaphore', () => ChannelReorderSemaphore.asEffect()),
    Effect.bind('messages', ({ rpc }) =>
      rpc['PersonalEvents/ListMessagesForMember']({ team_member_id: params.team_member_id }).pipe(
        Effect.catchTag('RpcClientError', () => Effect.succeed([] as ReadonlyArray<MemberMessage>)),
      ),
    ),
    Effect.flatMap(({ semaphore, messages }) =>
      messages.length <= 1
        ? Effect.void
        : semaphore.withChannelLock(messages[0].personal_channel_id)(
            reorderWithMessages(params, messages[0].personal_channel_id, messages),
          ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Unexpected error reordering personal channel for member ${params.team_member_id}`,
        cause,
      ),
    ),
  );
