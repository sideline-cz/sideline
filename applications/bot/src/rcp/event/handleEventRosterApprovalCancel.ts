import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';

export const handleEventRosterApprovalCancel = (
  event: EventRpcEvents.EventRosterApprovalCancelEvent,
) => {
  const threadId = Option.getOrNull(event.owners_thread_id);
  const messageId = Option.getOrNull(event.discord_message_id);

  if (threadId === null || messageId === null) {
    return Effect.void;
  }

  return Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rest }) =>
      rest.deleteMessage(threadId, messageId).pipe(
        Effect.asVoid,
        Effect.catchTag('ErrorResponse', (err) => {
          if (err.data.code === 10008) return Effect.void; // Unknown Message — already deleted
          return Effect.fail(err);
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `handleEventRosterApprovalCancel: failed to delete message ${messageId}`,
            cause,
          ),
        ),
      ),
    ),
  );
};
