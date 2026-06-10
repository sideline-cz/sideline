import { Discord, type EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { buildRosterApprovalMessage } from '~/rest/events/buildRosterApprovalMessage.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

/** Thread auto-archive: 7 days in minutes (maximum) */
const THREAD_AUTO_ARCHIVE_DURATION = 10080 as const;

/** Truncate a string to maxLen characters */
const truncate = (s: string, maxLen: number): string =>
  s.length <= maxLen ? s : s.slice(0, maxLen);

export const handleEventRosterApprovalRequest = (
  event: EventRpcEvents.EventRosterApprovalRequestEvent,
) =>
  Option.match(event.owner_channel_id, {
    onNone: () =>
      Effect.logWarning(
        `handleEventRosterApprovalRequest: no owner channel for event ${event.event_id}, skipping`,
      ),
    onSome: (ownerChannelId) =>
      Effect.Do.pipe(
        Effect.bind('rpc', () => SyncRpc.asEffect()),
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.flatMap(({ rpc, rest }) => {
          const payload = buildRosterApprovalMessage({
            eventId: event.event_id,
            eventTitle: event.title,
            startAt: event.start_at,
            memberId: event.team_member_id,
            candidateDiscordId: event.candidate_discord_id,
            candidateDisplayName: event.candidate_display_name,
            rosterName: event.roster_name,
            status: 'pending',
            locale: 'en',
          });

          // Create a new thread for this event, persist it, and resolve the winning thread id.
          // If another request won the save race, delete the orphan thread and use the winner's id.
          const createAndSaveThread = Effect.suspend(() =>
            rest
              .createThread(ownerChannelId, {
                name: truncate(`Roster approval: ${event.title}`, 100),
                type: 11 as const, // PUBLIC_THREAD
                auto_archive_duration: THREAD_AUTO_ARCHIVE_DURATION,
              })
              .pipe(
                Effect.bindTo('created'),
                Effect.bind('winner', ({ created }) =>
                  rpc['Event/SaveEventRosterThreadIfAbsent']({
                    event_id: event.event_id,
                    thread_id: decodeSnowflake(created.id),
                  }),
                ),
                Effect.flatMap(({ created, winner }) => {
                  const createdId = decodeSnowflake(created.id);
                  const winnerId = decodeSnowflake(Option.getOrElse(winner, () => created.id));
                  if (winnerId === createdId) return Effect.succeed(winnerId);
                  // Lost the save race — delete the orphan thread we just created (best-effort)
                  return rest.deleteChannel(createdId).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        'handleEventRosterApprovalRequest: failed to delete orphan thread',
                        cause,
                      ),
                    ),
                    Effect.as(winnerId),
                  );
                }),
              ),
          );

          // Resolve thread: use existing if present, otherwise create a new one.
          const resolveThread = Option.match(event.owners_thread_id, {
            onSome: Effect.succeed,
            onNone: () => createAndSaveThread,
          });

          // Post the embed to the thread; handle deleted thread (10003) by clearing + recreating.
          const postToThread = (threadId: Discord.Snowflake) =>
            Effect.suspend(() =>
              rest
                .createMessage(threadId, {
                  embeds: payload.embeds,
                  components: payload.components,
                  allowed_mentions: { parse: [] },
                })
                .pipe(
                  Effect.map((msg) => ({
                    threadId,
                    messageId: decodeSnowflake(msg.id),
                  })),
                  Effect.catchTag('ErrorResponse', (err) => {
                    // Accept either err.data.code (real dfx) or HTTP 404 (test mock compatibility)
                    const isUnknownChannel =
                      err.data?.code === 10003 || err.response?.status === 404;
                    if (!isUnknownChannel) return Effect.fail(err);
                    // Thread was deleted — clear, recreate, retry once
                    return rpc['Event/ClearEventRosterThread']({
                      event_id: event.event_id,
                    }).pipe(
                      Effect.flatMap(() => createAndSaveThread),
                      Effect.flatMap((newThreadId) =>
                        Effect.suspend(() =>
                          rest
                            .createMessage(newThreadId, {
                              embeds: payload.embeds,
                              components: payload.components,
                              allowed_mentions: { parse: [] },
                            })
                            .pipe(
                              Effect.map((retryMsg) => ({
                                threadId: newThreadId,
                                messageId: decodeSnowflake(retryMsg.id),
                              })),
                            ),
                        ),
                      ),
                    );
                  }),
                ),
            );

          return resolveThread.pipe(
            Effect.flatMap(postToThread),
            Effect.flatMap(({ messageId }) =>
              rpc['Event/SaveApprovalRequestMessageId']({
                event_id: event.event_id,
                team_member_id: event.team_member_id,
                message_id: messageId,
              }).pipe(
                Effect.tap(() =>
                  Effect.logInfo(
                    `Posted roster approval message for "${event.title}" (member ${event.team_member_id})`,
                  ),
                ),
              ),
            ),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `handleEventRosterApprovalRequest: failed for event ${event.event_id}`,
                cause,
              ),
            ),
          );
        }),
      ),
  });
