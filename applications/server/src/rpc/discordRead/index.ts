import { type DiscordReadRequest, DiscordReadRpcGroup } from '@sideline/domain';
import { Array, Effect } from 'effect';
import { DiscordReadRequestsRepository } from '~/repositories/DiscordReadRequestsRepository.js';

export const DiscordReadRpcLive = Effect.Do.pipe(
  Effect.bind('reads', () => DiscordReadRequestsRepository.asEffect()),
  Effect.map(({ reads }) => ({
    // Build the Class: `Schema.Class` is nominal, so a raw row type-checks here but fails at
    // encode time (see `rpc/invite/index.ts`).
    'DiscordRead/GetUnprocessedRequests': ({ limit }: { readonly limit: number }) =>
      reads.pickUnprocessed(limit).pipe(
        Effect.map(
          Array.map(
            (row) =>
              new DiscordReadRpcGroup.PendingDiscordRead({
                id: row.id,
                channel_id: row.channel_id,
                since: row.since_at,
                limit: row.message_limit,
              }),
          ),
        ),
      ),

    'DiscordRead/SubmitResult': ({
      id,
      result,
    }: {
      readonly id: DiscordReadRequest.DiscordReadRequestId;
      readonly result: DiscordReadRequest.DiscordReadResult;
    }) => reads.submitResult(id, result),
  })),
  (handlers) => DiscordReadRpcGroup.DiscordReadRpcGroup.toLayer(handlers),
);
