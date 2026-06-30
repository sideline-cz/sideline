import type { Discord as DiscordSchemas, Event, EventRpcModels } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, DateTime, Effect, Option, Order } from 'effect';
import type { Locale } from '~/locale.js';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { longestKeepablePrefix } from '~/rcp/event/reorderChannelMessages.js';
import { YES_EMBED_LIMIT } from '~/rest/events/buildEventEmbed.js';
import { buildPersonalMessage } from '~/rest/events/buildPersonalEventMessage.js';
import { SyncRpc } from '~/services/SyncRpc.js';

type MemberMessage = {
  readonly event_id: Event.EventId;
  readonly personal_channel_id: DiscordSchemas.Snowflake;
  readonly discord_message_id: DiscordSchemas.Snowflake;
  readonly start_at: DateTime.Utc;
};

/**
 * Order a member's personal messages the same way the global events channel is
 * ordered (see `sortEntriesForChannel`): personal channels only contain future
 * events, so they sort latest-start first — the soonest upcoming event ends up
 * at the bottom, nearest the input box. Ties break on event id.
 */
const desiredOrder = Order.make<MemberMessage>((a, b) => {
  const t = DateTime.Order(b.start_at, a.start_at);
  if (t !== 0) return t;
  return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
});

const reorderWithMessages = (
  params: {
    team_member_id: string;
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
                      const id = created.id as DiscordSchemas.Snowflake;
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
  team_member_id: string;
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
