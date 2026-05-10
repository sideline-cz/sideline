// TDD mode — tests for the guildMemberUpdate handler with OnboardingRoleCache.
// Will FAIL until Phase 5 implements:
//   applications/bot/src/services/OnboardingRoleCache.ts
//   and the updated guildMemberUpdate handler in events/index.ts

import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111';
const ROLE_ID_A = '555555555555555555';
const ROLE_ID_B = '666666666666666666';
const USER_ID = '777777777777777777';

const makeMemberPayload = (overrides: Record<string, unknown> = {}) => ({
  guild_id: GUILD_ID,
  user: { id: USER_ID, username: 'testuser', bot: false },
  roles: [] as string[],
  pending: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type RestCalls = { addGuildMemberRole: unknown[] };

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = { addGuildMemberRole: [] };
  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    addGuildMemberRole: (...args: any[]) => {
      calls.addGuildMemberRole.push(args);
      return Effect.void;
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

type RpcCalls = { GetOnboardingRulesRoleId: unknown[] };

const makeRpc = (
  roleForGuild: (guildId: string) => Option.Option<string>,
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = { GetOnboardingRulesRoleId: [] };
  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Guild/GetOnboardingRulesRoleId': (args: any) => {
      calls.GetOnboardingRulesRoleId.push(args);
      return Effect.succeed(roleForGuild(args.guild_id));
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

// A real in-memory cache layer for testing TTL and invalidation.
//
// IMPORTANT — TestClock contract for Phase 5 developer:
// The production OnboardingRoleCache implementation MUST use Effect.Clock
// (via Effect.clockWith(c => c.currentTimeMillis)) for its TTL, NOT raw
// Date.now(). If Date.now() is used, the "cache miss after TTL expiry" test
// below is non-deterministic (relies on real wall-clock elapsing, which is
// fragile in fast CI). Using Effect.Clock allows TestClock.advance() to fast-
// forward time without sleeping, making TTL tests deterministic. The test
// currently passes an already-expired entry via `expiresAt` to sidestep the
// need for TestClock on the TTL path, but any new time-sensitive behaviour
// must be wired through Effect.Clock.
const makeLiveCache = (
  initialEntries: Map<string, { value: Option.Option<string>; expiresAt: number }> = new Map(),
) => {
  const store = new Map(initialEntries);
  return Layer.succeed(OnboardingRoleCache, {
    get: (guildId: string) => {
      const entry = store.get(guildId);
      if (!entry || Date.now() > entry.expiresAt)
        return Effect.succeed(Option.none<Option.Option<string>>());
      return Effect.succeed(Option.some(entry.value));
    },
    set: (guildId: string, value: Option.Option<string>) => {
      store.set(guildId, { value, expiresAt: Date.now() + 60_000 });
      return Effect.void;
    },
    invalidate: (guildId: string) => {
      store.delete(guildId);
      return Effect.void;
    },
  } as any);
};

// ---------------------------------------------------------------------------
// Handler invocation helper (calls the event handler directly)
// ---------------------------------------------------------------------------

const invokeHandler = async (
  payload: ReturnType<typeof makeMemberPayload>,
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
  cacheLayer: Layer.Layer<OnboardingRoleCache>,
) => {
  // Dynamic import — will fail until Phase 5 implements this
  const { handleGuildMemberUpdate } = await import('~/events/guildMemberUpdate.js');
  return Effect.runPromise(
    handleGuildMemberUpdate(payload as any).pipe(
      Effect.provide(Layer.mergeAll(rpcLayer, restLayer, cacheLayer)),
    ),
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('guildMemberUpdate handler', () => {
  it('pending: false, no role match in member.roles → addGuildMemberRole called once', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache();

    await invokeHandler(makeMemberPayload({ roles: [] }), rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(1);
    expect(restCalls.addGuildMemberRole).toHaveLength(1);
  });

  it('pending: false, role already in member.roles → no addGuildMemberRole call (idempotency)', async () => {
    const { layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache();

    await invokeHandler(makeMemberPayload({ roles: [ROLE_ID_A] }), rpcLayer, restLayer, cacheLayer);

    expect(restCalls.addGuildMemberRole).toHaveLength(0);
  });

  it('pending: true → no RPC call, no REST call (cheap early bail)', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache();

    await invokeHandler(makeMemberPayload({ pending: true }), rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(0);
    expect(restCalls.addGuildMemberRole).toHaveLength(0);
  });

  it('pending: undefined → no RPC call, no REST call (early bail for missing field)', async () => {
    // Plan spec: skip immediately if member.pending !== false
    // undefined should be treated the same as true (not strictly false)
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache();

    await invokeHandler(makeMemberPayload({ pending: undefined }), rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(0);
    expect(restCalls.addGuildMemberRole).toHaveLength(0);
  });

  it('pending: false, GetOnboardingRulesRoleId returns None → no addGuildMemberRole call', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.none());
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache();

    await invokeHandler(makeMemberPayload(), rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(1);
    expect(restCalls.addGuildMemberRole).toHaveLength(0);
  });

  it('cache hit with roleId === None: cached None → no RPC, no REST call', async () => {
    // When the team explicitly has no rules role (cached as Option.none()),
    // the handler must short-circuit without firing any RPC or REST call.
    const primed = new Map([
      [GUILD_ID, { value: Option.none<string>(), expiresAt: Date.now() + 60_000 }],
    ]);
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache(primed);

    await invokeHandler(makeMemberPayload({ roles: [] }), rpcLayer, restLayer, cacheLayer);

    // Cache hit with None → no RPC fired to re-fetch
    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(0);
    // No role to assign
    expect(restCalls.addGuildMemberRole).toHaveLength(0);
  });

  it('cold cache, member.roles already includes the role → 0 addGuildMemberRole calls (idempotency after deploy)', async () => {
    // Most common case after a deploy: cache is empty, but the role is already on the member.
    // Should NOT call addGuildMemberRole — idempotency check fires before the REST call.
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache(); // empty cache

    await invokeHandler(makeMemberPayload({ roles: [ROLE_ID_A] }), rpcLayer, restLayer, cacheLayer);

    // RPC is called to populate the cold cache
    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(1);
    // REST is NOT called because the role is already present
    expect(restCalls.addGuildMemberRole).toHaveLength(0);
  });

  it('cache hit: second invocation with same guildId within TTL → no second RPC call', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache();

    // First call — cache miss, RPC fires
    await invokeHandler(makeMemberPayload({ roles: [ROLE_ID_A] }), rpcLayer, restLayer, cacheLayer);
    // Second call — should be cache hit
    await invokeHandler(makeMemberPayload({ roles: [ROLE_ID_A] }), rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(1);
  });

  it('cache miss: invocation after TTL expiry → fresh RPC call', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { layer: restLayer } = makeRest();
    // Pre-populate cache with an already-expired entry
    const expired = new Map([
      [GUILD_ID, { value: Option.some(ROLE_ID_A), expiresAt: Date.now() - 1 }],
    ]);
    const cacheLayer = makeLiveCache(expired);

    await invokeHandler(makeMemberPayload({ roles: [ROLE_ID_A] }), rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.GetOnboardingRulesRoleId).toHaveLength(1);
  });

  it('cache invalidation: after invalidate(guildId), next invocation re-fetches from RPC', async () => {
    // Start with roleA cached
    const primed = new Map([
      [GUILD_ID, { value: Option.some(ROLE_ID_A), expiresAt: Date.now() + 60_000 }],
    ]);
    const cacheLayer = makeLiveCache(primed);

    let callCount = 0;
    const { layer: rpcLayer } = makeRpc(() => {
      callCount++;
      return Option.some(ROLE_ID_B);
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    // Simulate cache bust (e.g. ProcessorService after successful sync)
    const { OnboardingRoleCache: CacheTag } = await import('~/services/OnboardingRoleCache.js');
    await Effect.runPromise(
      CacheTag.asEffect().pipe(
        Effect.flatMap((cache: any): Effect.Effect<void> => cache.invalidate(GUILD_ID)),
        Effect.provide(cacheLayer),
      ),
    );

    await invokeHandler(makeMemberPayload(), rpcLayer, restLayer, cacheLayer);

    // RPC should have been called (cache was invalidated)
    expect(callCount).toBeGreaterThan(0);
    // Should have tried to add roleB, not roleA
    expect(restCalls.addGuildMemberRole).toHaveLength(1);
  });

  it('addGuildMemberRole rate-limited → logged warning, effect succeeds', async () => {
    const { layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { layer: restLayer } = makeRest({
      addGuildMemberRole: () =>
        Effect.fail({
          _tag: 'RatelimitedResponse',
          message: 'Rate limited',
          retry_after: 1,
          global: false,
        }),
    });
    const cacheLayer = makeLiveCache();

    // Should not throw
    await expect(
      invokeHandler(makeMemberPayload(), rpcLayer, restLayer, cacheLayer),
    ).resolves.not.toThrow();
  });

  it('idempotency stress: invoke handler twice with same payload → exactly one addGuildMemberRole call total', async () => {
    const { layer: rpcLayer } = makeRpc(() => Option.some(ROLE_ID_A));
    const { calls: restCalls, layer: restLayer } = makeRest();
    const cacheLayer = makeLiveCache();

    // First call assigns role — second call should see role already present
    const payload1 = makeMemberPayload({ roles: [] });
    const payload2 = makeMemberPayload({ roles: [ROLE_ID_A] }); // simulates Discord reflecting the role back
    await invokeHandler(payload1, rpcLayer, restLayer, cacheLayer);
    await invokeHandler(payload2, rpcLayer, restLayer, cacheLayer);

    expect(restCalls.addGuildMemberRole).toHaveLength(1);
  });
});
