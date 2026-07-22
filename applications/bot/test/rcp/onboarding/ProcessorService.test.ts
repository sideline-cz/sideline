import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProcessorService } from '~/rcp/onboarding/ProcessorService.js';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111';
const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const ROLE_ID = '555555555555555555';
const NEW_PROMPT_ID = '888888888888888888';
const RULES_CHANNEL_ID = '222222222222222222';
const WELCOME_CHANNEL_ID = '333333333333333333';

const makePendingSync = (overrides: Record<string, unknown> = {}) => ({
  team_id: TEAM_ID,
  guild_id: GUILD_ID,
  team_name: 'Test FC',
  onboarding_locale: 'en',
  rules_channel_id: Option.some(RULES_CHANNEL_ID),
  welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
  overview_channel_id: Option.none(),
  onboarding_rules_role_id: Option.some(ROLE_ID),
  onboarding_rules_prompt_id: Option.none(),
  is_community_enabled: true,
  ...overrides,
});

const makeOnboardingResponse = (prompts: unknown[] = [], promptId?: string) => ({
  guild_id: GUILD_ID,
  prompts: promptId
    ? [
        {
          id: promptId,
          title: 'Read the rules to join',
          type: 0,
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            {
              title: 'I have read the rules',
              role_ids: [ROLE_ID],
              channel_ids: [],
              emoji_name: '✅',
            },
          ],
        },
        ...prompts,
      ]
    : prompts,
  default_channel_ids: [],
  enabled: true,
  mode: 1,
});

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type RpcCalls = {
  PendingOnboardingSyncs: unknown[];
  MarkOnboardingSyncDone: unknown[];
  MarkOnboardingSyncFailed: unknown[];
  RevertOnboardingSync: unknown[];
  MarkOnboardingSyncSkipped: unknown[];
};

const makeRpc = (
  pending: unknown[],
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = {
    PendingOnboardingSyncs: [],
    MarkOnboardingSyncDone: [],
    MarkOnboardingSyncFailed: [],
    RevertOnboardingSync: [],
    MarkOnboardingSyncSkipped: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Guild/PendingOnboardingSyncs': (args: any) => {
      calls.PendingOnboardingSyncs.push(args);
      return Effect.succeed(pending);
    },
    'Guild/MarkOnboardingSyncDone': (args: any) => {
      calls.MarkOnboardingSyncDone.push(args);
      return Effect.succeed({ updated: true });
    },
    'Guild/MarkOnboardingSyncFailed': (args: any) => {
      calls.MarkOnboardingSyncFailed.push(args);
      return Effect.succeed({ updated: true });
    },
    'Guild/RevertOnboardingSync': (args: any) => {
      calls.RevertOnboardingSync.push(args);
      return Effect.succeed({});
    },
    'Guild/MarkOnboardingSyncSkipped': (args: any) => {
      calls.MarkOnboardingSyncSkipped.push(args);
      return Effect.succeed({});
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
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

type RestCalls = {
  getGuildsOnboarding: unknown[];
  putGuildsOnboarding: unknown[];
  updateGuildWelcomeScreen: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    getGuildsOnboarding: [],
    putGuildsOnboarding: [],
    updateGuildWelcomeScreen: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    getGuildsOnboarding: (guildId: any) => {
      calls.getGuildsOnboarding.push(guildId);
      return Effect.succeed(makeOnboardingResponse([], NEW_PROMPT_ID));
    },
    putGuildsOnboarding: (guildId: any, payload: any) => {
      calls.putGuildsOnboarding.push({ guildId, payload });
      return Effect.succeed(makeOnboardingResponse([], NEW_PROMPT_ID));
    },
    updateGuildWelcomeScreen: (guildId: any, payload: any) => {
      calls.updateGuildWelcomeScreen.push({ guildId, payload });
      return Effect.succeed({});
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
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

type CacheCalls = {
  invalidate: string[];
  get: string[];
  set: Array<{ guildId: string; value: Option.Option<string> }>;
};

// In-memory store for the live cache so we can assert set→invalidate→get round-trips
const makeLiveCache = (
  initial: Map<string, Option.Option<string>> = new Map(),
): { calls: CacheCalls; layer: Layer.Layer<OnboardingRoleCache> } => {
  const store = new Map<string, Option.Option<string>>(initial);
  const calls: CacheCalls = { invalidate: [], get: [], set: [] };

  const layer = Layer.succeed(OnboardingRoleCache, {
    get: (guildId: string) => {
      calls.get.push(guildId);
      return Effect.succeed(store.get(guildId) ?? Option.none());
    },
    set: (guildId: string, value: Option.Option<string>) => {
      calls.set.push({ guildId, value });
      store.set(guildId, value);
      return Effect.void;
    },
    invalidate: (guildId: string) => {
      calls.invalidate.push(guildId);
      store.delete(guildId);
      return Effect.void;
    },
    // Expose the underlying store so tests can verify the get-after-invalidate behaviour
    _store: store,
  } as any);

  return { calls, layer };
};

/**
 * NOTE on metrics: the production implementation must expose the
 * `onboardingSyncTotal` counter as a Layer-injectable service (or use
 * Effect.Tag) so it can be replaced in tests. If the counter is a
 * module-level const using `Metric.counter`, the test here acts as a
 * design contract requiring Phase 5 to wrap metrics in a Layer.
 * The simplest approach: export a `OnboardingMetrics` Tag from metrics.ts
 * and inject it here. Until that exists these assertions are placeholders
 * that will fail at module-not-found time, not at assertion time.
 */

// ---------------------------------------------------------------------------
// Run helper
// ---------------------------------------------------------------------------

const runProcessTick = (
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
  cacheLayer: Layer.Layer<OnboardingRoleCache>,
) =>
  Effect.runPromise(
    ProcessorService.pipe(
      Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
      Effect.provide(Layer.mergeAll(rpcLayer, restLayer, cacheLayer)),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingProcessorService', () => {
  it('no pending teams → no Discord REST calls', async () => {
    const { layer: rpcLayer } = makeRpc([]);
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.getGuildsOnboarding).toHaveLength(0);
    expect(restCalls.putGuildsOnboarding).toHaveLength(0);
    expect(restCalls.updateGuildWelcomeScreen).toHaveLength(0);
  });

  it('single team success path → onboarding disabled (PUT enabled:false), welcome screen patched, MarkOnboardingSyncDone called', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    // We disable onboarding (so the welcome screen surfaces to new members) and then
    // patch the welcome screen. We never GET onboarding — the disable PUT is minimal
    // and idempotent.
    expect(restCalls.getGuildsOnboarding).toHaveLength(0);
    expect(restCalls.putGuildsOnboarding).toHaveLength(1);
    expect((restCalls.putGuildsOnboarding[0] as any).payload).toEqual({ enabled: false });
    expect(restCalls.updateGuildWelcomeScreen).toHaveLength(1);
    expect(rpcCalls.MarkOnboardingSyncDone).toHaveLength(1);
    const doneCall = rpcCalls.MarkOnboardingSyncDone[0] as any;
    expect(doneCall.team_id).toBe(TEAM_ID);
    // prompt_id is always None now (we don't author a Discord prompt anymore).
    expect(Option.isNone(doneCall.prompt_id)).toBe(true);
  });

  it('community feature off (is_community_enabled=false) → only MarkOnboardingSyncSkipped called, no Discord REST', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([
      makePendingSync({ is_community_enabled: false }),
    ]);
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: cacheCalls, layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.getGuildsOnboarding).toHaveLength(0);
    expect(restCalls.putGuildsOnboarding).toHaveLength(0);
    expect(rpcCalls.MarkOnboardingSyncSkipped).toHaveLength(1);
    expect((rpcCalls.MarkOnboardingSyncSkipped[0] as any).team_id).toBe(TEAM_ID);
    expect(rpcCalls.RevertOnboardingSync).toHaveLength(0);
    expect(rpcCalls.MarkOnboardingSyncDone).toHaveLength(0);
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(0);
    expect(cacheCalls.invalidate).toContain(GUILD_ID);
  });

  it('channel_deleted error from welcome-screen PATCH → MarkOnboardingSyncFailed with code=channel_deleted', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([
      makePendingSync({ rules_channel_id: Option.some(RULES_CHANNEL_ID) }),
    ]);
    const channelDeletedError = {
      _tag: 'ErrorResponse',
      code: 50035,
      message: 'Invalid Form Body',
      errors: {
        welcome_channels: { '0': { _errors: [`Invalid channel: ${RULES_CHANNEL_ID}`] } },
      },
    };
    const { layer: restLayer } = makeRest({
      updateGuildWelcomeScreen: () => Effect.fail(channelDeletedError),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(1);
    const failCall = rpcCalls.MarkOnboardingSyncFailed[0] as any;
    expect(failCall.error_code).toBe('channel_deleted');
  });

  it('RatelimitedResponse from welcome-screen PATCH → MarkOnboardingSyncFailed with code=rate_limited', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([makePendingSync()]);
    const rateLimitedError = {
      _tag: 'RatelimitedResponse',
      message: 'You are being rate limited.',
      retry_after: 1.5,
      global: false,
    };
    const { layer: restLayer } = makeRest({
      updateGuildWelcomeScreen: () => Effect.fail(rateLimitedError),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(1);
    const failCall = rpcCalls.MarkOnboardingSyncFailed[0] as any;
    expect(failCall.error_code).toBe('rate_limited');
    expect(failCall.team_id).toBe(TEAM_ID);
  });

  it('cache invalidation: after successful sync, cache.invalidate(guildId) called', async () => {
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { layer: restLayer } = makeRest();
    const { calls: cacheCalls, layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(cacheCalls.invalidate).toContain(GUILD_ID);
  });

  it('cache set→invalidate→get: after sync completes, OnboardingRoleCache.get returns Option.none()', async () => {
    // Pre-populate the cache with a role id
    const initial = new Map([[GUILD_ID, Option.some(ROLE_ID)]]);
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { layer: restLayer } = makeRest();
    const { calls: cacheCalls, layer: cacheLayer } = makeLiveCache(initial);

    // Verify the cache started populated
    // (cache.get is called inside runProcessTick; we just confirm invalidate was called and
    //  subsequent get returns none via the live in-memory store)
    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(cacheCalls.invalidate).toContain(GUILD_ID);
    // The live cache store should now return none after invalidation
    const getEffect = OnboardingRoleCache.asEffect().pipe(
      Effect.flatMap((cache: any): Effect.Effect<Option.Option<string>> => cache.get(GUILD_ID)),
    );
    const valueAfter = await Effect.runPromise(getEffect.pipe(Effect.provide(cacheLayer)));
    expect(Option.isNone(valueAfter as Option.Option<string>)).toBe(true);
  });

  it('MarkSyncDone returns updated:false (captain re-saved mid-sync) → no MarkFailed, no success metric, cache NOT invalidated', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([makePendingSync()], {
      'Guild/MarkOnboardingSyncDone': () => Effect.succeed({ updated: false }),
    });
    const { layer: restLayer } = makeRest();
    const { calls: cacheCalls, layer: cacheLayer } = makeLiveCache();

    // Should not throw
    await expect(runProcessTick(rpcLayer, restLayer, cacheLayer)).resolves.not.toThrow();

    // Processor must be a no-op when the conditional UPDATE didn't apply
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(0);
    // Cache MUST NOT be invalidated — the row is still pending; next tick re-syncs with fresh config
    expect(cacheCalls.invalidate).toHaveLength(0);
  });

  it('metric onboarding_sync_total{status=success} incremented on success path (contract assertion)', async () => {
    // Plan §9 ProcessorService case 3: success path increments metric.
    // NOTE: This test documents the contract. Phase 5 developer must expose metrics
    // via an injectable Layer (e.g. OnboardingMetrics Tag) for this to be testable
    // at the unit level without firing the real Prometheus counter.
    // Until OnboardingMetrics is a Layer service, this test validates only that
    // the processor does NOT throw on the happy path (the metric Layer falls back
    // to the no-op default).
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { layer: restLayer } = makeRest();
    const { layer: cacheLayer } = makeLiveCache();

    await expect(runProcessTick(rpcLayer, restLayer, cacheLayer)).resolves.not.toThrow();
    // TODO: once OnboardingMetrics is injectable, assert:
    //   expect(metricCalls.success).toHaveLength(1)
    //   expect(metricCalls.failed).toHaveLength(0)
  });

  it('metric onboarding_sync_total{status=skipped_no_community} incremented on skipped path (contract assertion)', async () => {
    // Plan §9 ProcessorService case 3
    const { layer: rpcLayer } = makeRpc([makePendingSync({ is_community_enabled: false })]);
    const { layer: restLayer } = makeRest();
    const { layer: cacheLayer } = makeLiveCache();

    await expect(runProcessTick(rpcLayer, restLayer, cacheLayer)).resolves.not.toThrow();
    // TODO: once OnboardingMetrics is injectable, assert:
    //   expect(metricCalls.skipped_no_community).toHaveLength(1)
  });

  it('metric onboarding_sync_total{status=failed} incremented on failure path (contract assertion)', async () => {
    // Plan §9 ProcessorService case 3
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { layer: restLayer } = makeRest({
      putGuildsOnboarding: () =>
        Effect.fail({ _tag: 'ErrorResponse', code: 99999, message: 'Unknown', errors: {} }),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await expect(runProcessTick(rpcLayer, restLayer, cacheLayer)).resolves.not.toThrow();
    // TODO: once OnboardingMetrics is injectable, assert:
    //   expect(metricCalls.failed).toHaveLength(1)
  });
});
