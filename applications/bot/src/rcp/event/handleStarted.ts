import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';

export const handleStarted = (event: EventRpcEvents.EventStartedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rpc, rest }) => {
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

      return Effect.exit(deleteClaim).pipe(
        Effect.tap((exit) =>
          exit._tag === 'Failure'
            ? Effect.logWarning('handleStarted: delete claim failed', exit.cause)
            : Effect.void,
        ),
        Effect.asVoid,
      );
    }),
  );
