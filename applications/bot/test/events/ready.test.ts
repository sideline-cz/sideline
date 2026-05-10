// TDD mode — tests for the READY handler: community flag backfill + pagination + chunking.
// Will FAIL until Phase 5 implements the READY handler in applications/bot/src/events/index.ts.

import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type RpcCalls = {
  SyncCommunityFlags: unknown[];
  SyncGuildRoles: unknown[];
};

const makeRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = { SyncCommunityFlags: [], SyncGuildRoles: [] };
  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Guild/SyncCommunityFlags': (args: any) => {
      calls.SyncCommunityFlags.push(args);
      return Effect.void;
    },
    'Guild/SyncGuildRoles': (args: any) => {
      calls.SyncGuildRoles.push(args);
      return Effect.void;
    },
  };
  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        // Tightened fallback: throw on unknown methods to surface typos in production code
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) throw new Error(`Unmocked RPC method: ${prop}`);
        return fn;
      },
    }),
  );
  return { calls, layer };
};

type RestCalls = { listMyGuilds: unknown[] };

const makeGuild = (id: string, isCommunity: boolean) => ({
  id,
  name: `Guild ${id}`,
  icon: null,
  owner: false,
  permissions: '0',
  features: isCommunity ? ['COMMUNITY'] : [],
});

const makeRest = (
  pages: Array<ReturnType<typeof makeGuild>[]>,
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = { listMyGuilds: [] };
  let pageIndex = 0;

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    listMyGuilds: (args: any) => {
      calls.listMyGuilds.push(args);
      const page = pages[pageIndex] ?? [];
      pageIndex++;
      return Effect.succeed(page);
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        // Tightened fallback: throw on unknown methods to surface typos in production code
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) throw new Error(`Unmocked REST method: ${prop}`);
        return fn;
      },
    }),
  );
  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Handler invocation helper
// ---------------------------------------------------------------------------

const invokeReadyHandler = async (
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
) => {
  const { handleReady } = await import('~/events/ready.js');
  return Effect.runPromise(handleReady().pipe(Effect.provide(Layer.merge(rpcLayer, restLayer))));
};

// ---------------------------------------------------------------------------
// Guild id factories
// ---------------------------------------------------------------------------

const makeGuilds = (count: number, startIndex = 0, isCommunity = false) =>
  Array.from({ length: count }, (_, i) =>
    makeGuild(String(100_000_000_000_000_000n + BigInt(startIndex + i)), isCommunity),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('READY handler — community flag backfill', () => {
  it('READY with 50 guilds → SyncCommunityFlags called once with 50 entries', async () => {
    const guilds = [...makeGuilds(25, 0, true), ...makeGuilds(25, 25, false)];
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();
    // Single short page (< 200) means pagination ends immediately
    const { layer: restLayer } = makeRest([guilds]);

    await invokeReadyHandler(rpcLayer, restLayer);

    expect(rpcCalls.SyncCommunityFlags).toHaveLength(1);
    const payload = (rpcCalls.SyncCommunityFlags[0] as any).guilds;
    expect(payload).toHaveLength(50);
    // Check booleans are mapped correctly
    const communityEntry = payload.find((g: any) =>
      guilds
        .slice(0, 25)
        .map((x) => x.id)
        .includes(g.guild_id),
    );
    expect(communityEntry?.is_community_enabled).toBe(true);
    const nonCommunityEntry = payload.find((g: any) =>
      guilds
        .slice(25)
        .map((x) => x.id)
        .includes(g.guild_id),
    );
    expect(nonCommunityEntry?.is_community_enabled).toBe(false);
  });

  it('READY with 0 guilds → no RPC call', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();
    const { layer: restLayer } = makeRest([[]]);

    await invokeReadyHandler(rpcLayer, restLayer);

    expect(rpcCalls.SyncCommunityFlags).toHaveLength(0);
  });

  it('RPC failure → swallowed, no uncaught exception', async () => {
    const { layer: rpcLayer } = makeRpc({
      'Guild/SyncCommunityFlags': () => Effect.fail({ _tag: 'RpcClientError', message: 'down' }),
    });
    const { layer: restLayer } = makeRest([makeGuilds(3)]);

    await expect(invokeReadyHandler(rpcLayer, restLayer)).resolves.not.toThrow();
  });

  it('single short page (199 entries < 200 limit) → listMyGuilds called exactly once, terminates', async () => {
    // The pagination loop must stop when the page is shorter than the limit (< 200).
    // This proves the termination condition without a second HTTP call.
    const page1 = makeGuilds(199, 0);
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();
    const { calls: restCalls, layer: restLayer } = makeRest([page1]);

    await invokeReadyHandler(rpcLayer, restLayer);

    // Exactly one REST call — the short page signals end-of-list
    expect(restCalls.listMyGuilds).toHaveLength(1);
    // All 199 entries forwarded to RPC in a single chunk (< 500 threshold)
    expect(rpcCalls.SyncCommunityFlags).toHaveLength(1);
    expect((rpcCalls.SyncCommunityFlags[0] as any).guilds).toHaveLength(199);
  });

  it('pagination: page of 200 + page of 47 → listMyGuilds called twice, SyncCommunityFlags payload has 247 entries', async () => {
    const page1 = makeGuilds(200, 0);
    const page2 = makeGuilds(47, 200);
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();
    const { calls: restCalls, layer: restLayer } = makeRest([page1, page2]);

    await invokeReadyHandler(rpcLayer, restLayer);

    expect(restCalls.listMyGuilds).toHaveLength(2);
    // The second call should have an `after` cursor set to the last id of page1
    const secondCallArgs = restCalls.listMyGuilds[1] as any;
    expect(secondCallArgs.after).toBe(page1[page1.length - 1].id);

    const totalEntries = rpcCalls.SyncCommunityFlags.reduce(
      (sum: number, call: any) => sum + call.guilds.length,
      0,
    );
    expect(totalEntries).toBe(247);
  });

  it('chunking: 1234 guilds → SyncCommunityFlags called 3 times (500/500/234)', async () => {
    // Simulate pagination returning all 1234 guilds across multiple pages of 200
    const allGuilds = makeGuilds(1234, 0);
    // Pages: 200, 200, 200, 200, 200, 200, 34 (7 pages)
    const pages: ReturnType<typeof makeGuild>[][] = [];
    for (let i = 0; i < allGuilds.length; i += 200) {
      pages.push(allGuilds.slice(i, Math.min(i + 200, allGuilds.length)));
    }
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();
    const { layer: restLayer } = makeRest(pages);

    await invokeReadyHandler(rpcLayer, restLayer);

    expect(rpcCalls.SyncCommunityFlags).toHaveLength(3);
    expect((rpcCalls.SyncCommunityFlags[0] as any).guilds).toHaveLength(500);
    expect((rpcCalls.SyncCommunityFlags[1] as any).guilds).toHaveLength(500);
    expect((rpcCalls.SyncCommunityFlags[2] as any).guilds).toHaveLength(234);
  });

  it('SyncCommunityFlags maps guild.features.includes("COMMUNITY") to is_community_enabled', async () => {
    const guilds = [makeGuild('100', true), makeGuild('200', false), makeGuild('300', true)];
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();
    const { layer: restLayer } = makeRest([guilds]);

    await invokeReadyHandler(rpcLayer, restLayer);

    const payload = (rpcCalls.SyncCommunityFlags[0] as any).guilds as any[];
    expect(payload.find((g) => g.guild_id === '100')?.is_community_enabled).toBe(true);
    expect(payload.find((g) => g.guild_id === '200')?.is_community_enabled).toBe(false);
    expect(payload.find((g) => g.guild_id === '300')?.is_community_enabled).toBe(true);
  });
});
