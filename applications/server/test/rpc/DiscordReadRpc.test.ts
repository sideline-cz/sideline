// `DiscordRead/*` handlers against a mock repository. Test 1 is the nominal-Class guard every
// `success: Schema.Array(SomeClass)` outbox needs (see `InvitePendingAcceptancesEncode.test.ts`):
// returning the raw repository rows type-checks but fails at encode time.

import { describe, expect, it } from '@effect/vitest';
import { type Discord, type DiscordReadRequest, DiscordReadRpcGroup } from '@sideline/domain';
import { Effect, Layer, Option, Schema } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { DiscordReadRequestsRepository } from '~/repositories/DiscordReadRequestsRepository.js';
import { DiscordReadRpcLive } from '~/rpc/discordRead/index.js';

const REQUEST_ID =
  '00000000-0000-1000-8000-000000000001' as DiscordReadRequest.DiscordReadRequestId;

const submitted: Array<{ id: string; result: DiscordReadRequest.DiscordReadResult }> = [];

const MockRepoLayer = Layer.succeed(DiscordReadRequestsRepository, {
  pickUnprocessed: () =>
    Effect.succeed([
      {
        id: REQUEST_ID,
        channel_id: '200000000000000002' as Discord.Snowflake,
        since_at: Option.none(),
        message_limit: 50,
      },
    ]),
  submitResult: (id: string, result: DiscordReadRequest.DiscordReadResult) =>
    Effect.sync(() => {
      submitted.push({ id, result });
    }),
} as never);

const TestLayer = DiscordReadRpcLive.pipe(Layer.provide(MockRepoLayer));

const withClient = <A>(f: (rpc: any) => Effect.Effect<A, unknown>) =>
  Effect.scoped(
    (RpcTest.makeClient(DiscordReadRpcGroup.DiscordReadRpcGroup) as Effect.Effect<any>).pipe(
      Effect.flatMap(f),
    ),
  ).pipe(Effect.provide(TestLayer));

describe('DiscordRead RPC', () => {
  it.effect('GetUnprocessedRequests returns values that encode as PendingDiscordRead', () =>
    Effect.gen(function* () {
      const rows = yield* withClient((rpc) =>
        rpc['DiscordRead/GetUnprocessedRequests']({ limit: 5 }),
      );
      const encoded = Schema.encodeSync(Schema.Array(DiscordReadRpcGroup.PendingDiscordRead))(
        rows as never,
      );
      expect(encoded).toEqual([
        { id: REQUEST_ID, channel_id: '200000000000000002', since: null, limit: 50 },
      ]);
    }),
  );

  it.effect('SubmitResult forwards id and result to the repository unchanged', () =>
    Effect.gen(function* () {
      const result: DiscordReadRequest.DiscordReadResult = {
        outcome: 'no_access',
        messages: [],
        capped: false,
      };
      yield* withClient((rpc) => rpc['DiscordRead/SubmitResult']({ id: REQUEST_ID, result }));
      expect(submitted).toEqual([{ id: REQUEST_ID, result }]);
    }),
  );
});
