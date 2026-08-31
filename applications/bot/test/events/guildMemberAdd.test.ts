/**
 * PR-8 (CC-10, blocker 7) — the `GuildMemberAdd` dispatch must pass `source: Some('member_add')`
 * on every `Guild/RegisterMember` call. There is no `guildMemberAdd.ts`; the dispatch is inline
 * in `events/index.ts` (`eventHandlers`'s `guildMemberAdd` field), so this test captures the
 * registered dispatch callback via a mocked `DiscordGateway.handleDispatch` and invokes it
 * directly, rather than importing a standalone handler function.
 */

import { DiscordREST } from 'dfx/DiscordREST';
import { DiscordGateway } from 'dfx/gateway';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { eventHandlers } from '~/events/index.js';
import { InviteCache } from '~/services/InviteCache.js';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '111111111111111111';
const USER_ID = '222222222222222222';

const makeMemberAddPayload = () => ({
  guild_id: GUILD_ID,
  user: { id: USER_ID, username: 'new-member', avatar: null, global_name: null, bot: false },
  roles: [] as string[],
  nick: null,
  joined_at: new Date().toISOString(),
  deaf: false,
  mute: false,
});

const MockDiscordRESTLayer = Layer.succeed(
  DiscordREST,
  new Proxy({} as any, {
    get: (_target: unknown, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      // listGuildInvites (used to compute matched invite code) — no invites in flight.
      return () => Effect.succeed([]);
    },
  }),
);

describe('GuildMemberAdd dispatch (events/index.ts) — PR-8 source provenance', () => {
  it("passes source 'member_add' on Guild/RegisterMember", async () => {
    const registerMemberCalls: Array<{ source: Option.Option<string> }> = [];
    let capturedHandler:
      | ((payload: unknown) => Effect.Effect<unknown, unknown, unknown>)
      | undefined;

    const MockGatewayLayer = Layer.succeed(DiscordGateway, {
      [DiscordGateway.key]: DiscordGateway.key,
      dispatch: undefined as never,
      fromDispatch: undefined as never,
      handleDispatch: (
        event: string,
        handle: (payload: unknown) => Effect.Effect<unknown, unknown, unknown>,
      ) => {
        if (event === DiscordTypes.GatewayDispatchEvents.GuildMemberAdd) {
          capturedHandler = handle;
        }
        return Effect.never;
      },
      send: () => Effect.succeed(true),
      shards: Effect.succeed(new Set()),
    } as never);

    const MockSyncRpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
          if (prop === 'Guild/RegisterMember') {
            return (args: { source: Option.Option<string> }) => {
              registerMemberCalls.push({ source: args.source });
              return Effect.succeed(Option.none());
            };
          }
          return () => Effect.void;
        },
      }),
    );

    const testLayer = Layer.mergeAll(
      MockGatewayLayer,
      MockSyncRpcLayer,
      MockDiscordRESTLayer,
      InviteCache.Default,
      OnboardingRoleCache.Default,
    );

    // Building `eventHandlers` only registers dispatch callbacks (via `handleDispatch`) — it does
    // not run the gateway loop, so this resolves immediately once every `Effect.let` has captured
    // its handler.
    await Effect.runPromise(eventHandlers.pipe(Effect.asVoid, Effect.provide(testLayer)));

    expect(capturedHandler).toBeDefined();

    await Effect.runPromise(
      (capturedHandler as (payload: unknown) => Effect.Effect<unknown, unknown, unknown>)(
        makeMemberAddPayload(),
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<unknown, never, never>,
    );

    expect(registerMemberCalls).toHaveLength(1);
    expect(Option.isSome(registerMemberCalls[0]?.source ?? Option.none())).toBe(true);
    expect(Option.getOrNull(registerMemberCalls[0]?.source ?? Option.none())).toBe('member_add');
  });
});
