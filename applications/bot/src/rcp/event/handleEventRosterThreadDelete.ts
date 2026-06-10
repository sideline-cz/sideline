import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';

export const handleEventRosterThreadDelete = (
  event: EventRpcEvents.EventRosterThreadDeleteEvent,
) => {
  const threadId = Option.getOrNull(event.owners_thread_id);

  if (threadId === null) {
    return Effect.void;
  }

  return Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rest }) =>
      rest.deleteChannel(threadId).pipe(
        Effect.asVoid,
        Effect.catchTag('ErrorResponse', (err) => {
          if (err.data.code === 10003) return Effect.void; // Unknown Channel — already deleted
          return Effect.fail(err);
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `handleEventRosterThreadDelete: failed to delete thread ${threadId}`,
            cause,
          ),
        ),
      ),
    ),
  );
};
