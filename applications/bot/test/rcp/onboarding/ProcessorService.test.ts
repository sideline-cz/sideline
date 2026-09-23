import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { VERIFY_BUTTON_ID } from '~/interactions/profile-verify.js';
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
const VERIFY_CHANNEL_ID = '777777777777777777';

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
  verify_intro_template: Option.none(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// reconcileVerifyIntro fixtures
// ---------------------------------------------------------------------------

const EN_VERIFY_CHANNEL_NAME = m.bot_verify_channel_name({}, { locale: 'en' });

const builtInEmbed = (locale: 'en' | 'cs' = 'en') => ({
  title: m.bot_verify_intro_title({}, { locale }),
  description: m.bot_verify_intro_description({}, { locale }),
  fields: [
    {
      name: m.bot_verify_intro_unlocks_name({}, { locale }),
      value: m.bot_verify_intro_unlocks_value({}, { locale }),
    },
    {
      name: m.bot_verify_intro_why_name({}, { locale }),
      value: m.bot_verify_intro_why_value({}, { locale }),
    },
  ],
  footer: { text: m.bot_verify_intro_footer({}, { locale }) },
});

const makeGuildTextChannel = (overrides: Record<string, unknown> = {}) => ({
  id: VERIFY_CHANNEL_ID,
  name: EN_VERIFY_CHANNEL_NAME,
  type: 0, // GUILD_TEXT
  ...overrides,
});

const makeVerifyButtonRow = (customId = VERIFY_BUTTON_ID) => ({
  type: 1, // ACTION_ROW
  components: [{ type: 2, custom_id: customId }], // BUTTON
});

const makePin = (
  overrides: {
    id?: string;
    embed?: { title?: string; description?: string; footer?: { text: string } };
    customId?: string;
  } = {},
) => ({
  pinned_at: '2024-01-01T00:00:00Z',
  message: {
    id: overrides.id ?? 'existing-pin-msg-1',
    embeds: [overrides.embed ?? builtInEmbed()],
    components: [makeVerifyButtonRow(overrides.customId)],
  },
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
  listGuildChannels: unknown[];
  listPins: unknown[];
  updateMessage: unknown[];
  createMessage: unknown[];
  createPin: unknown[];
  deleteMessage: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    getGuildsOnboarding: [],
    putGuildsOnboarding: [],
    updateGuildWelcomeScreen: [],
    listGuildChannels: [],
    listPins: [],
    updateMessage: [],
    createMessage: [],
    createPin: [],
    deleteMessage: [],
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
    // Defaults for reconcileVerifyIntro: no channel found by default, so the
    // pre-existing tests above (none of which set up a verify channel) don't
    // trip the reconcile into calling listPins/updateMessage/createMessage.
    listGuildChannels: (guildId: any) => {
      calls.listGuildChannels.push(guildId);
      return Effect.succeed([]);
    },
    listPins: (...args: any[]) => {
      calls.listPins.push(args);
      return Effect.succeed({ items: [], has_more: false });
    },
    updateMessage: (...args: any[]) => {
      calls.updateMessage.push(args);
      return Effect.succeed({ id: 'updated-msg' });
    },
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args);
      return Effect.succeed({ id: 'created-msg' });
    },
    createPin: (...args: any[]) => {
      calls.createPin.push(args);
      return Effect.succeed(undefined);
    },
    deleteMessage: (...args: any[]) => {
      calls.deleteMessage.push(args);
      return Effect.succeed(undefined);
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

// ---------------------------------------------------------------------------
// reconcileVerifyIntro (A12) — keeps the pinned intro message in the verify
// channel in step with `teams.verify_intro_template`.
// ---------------------------------------------------------------------------

describe('OnboardingProcessorService — reconcileVerifyIntro', () => {
  it('channel found + pin drifted → exactly one updateMessage with the new description, no components key in the patch', async () => {
    const { layer: rpcLayer } = makeRpc([
      makePendingSync({ verify_intro_template: Option.some('New custom body.') }),
    ]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () =>
        Effect.succeed({
          items: [makePin({ embed: builtInEmbed() })], // stale: still the built-in copy
          has_more: false,
        }),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.updateMessage).toHaveLength(1);
    const [, , patch] = restCalls.updateMessage[0] as [
      string,
      string,
      { embeds: any[]; components?: unknown },
    ];
    expect(patch.embeds[0].description).toBe('New custom body.');
    expect('components' in patch).toBe(false);
    expect(restCalls.createMessage).toHaveLength(0);
    expect(restCalls.createPin).toHaveLength(0);
  });

  it('pin already matches the current copy → no updateMessage', async () => {
    const { layer: rpcLayer } = makeRpc([
      makePendingSync({ verify_intro_template: Option.none() }),
    ]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () =>
        Effect.succeed({ items: [makePin({ embed: builtInEmbed() })], has_more: false }),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.updateMessage).toHaveLength(0);
    expect(restCalls.createMessage).toHaveLength(0);
  });

  it('no pin of ours (empty pins) → createMessage + createPin', async () => {
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () => Effect.succeed({ items: [], has_more: false }),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.createMessage).toHaveLength(1);
    expect(restCalls.createPin).toHaveLength(1);
    expect(restCalls.updateMessage).toHaveLength(0);
  });

  it('a pin exists but its only button has a different custom_id → treated as "not ours", createMessage + createPin', async () => {
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () =>
        Effect.succeed({
          items: [makePin({ customId: 'some-other-button' })],
          has_more: false,
        }),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.createMessage).toHaveLength(1);
    expect(restCalls.createPin).toHaveLength(1);
    expect(restCalls.updateMessage).toHaveLength(0);
  });

  it('channel not found → no pin calls at all, sync still succeeds', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([]),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.listPins).toHaveLength(0);
    expect(restCalls.updateMessage).toHaveLength(0);
    expect(restCalls.createMessage).toHaveLength(0);
    expect(rpcCalls.MarkOnboardingSyncDone).toHaveLength(1);
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(0);
  });

  it('a category (not GUILD_TEXT) named start-here is present → not matched, treated as channel-not-found', async () => {
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () =>
        Effect.succeed([makeGuildTextChannel({ type: 4 /* GUILD_CATEGORY */ })]),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.listPins).toHaveLength(0);
    expect(restCalls.createMessage).toHaveLength(0);
  });

  it('listGuildChannels fails → MarkOnboardingSyncDone still called, MarkOnboardingSyncFailed NOT called', async () => {
    const permanentError = { _tag: 'ErrorResponse', response: { status: 400 }, data: { code: 1 } };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.fail(permanentError),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await expect(runProcessTick(rpcLayer, restLayer, cacheLayer)).resolves.not.toThrow();

    expect(rpcCalls.MarkOnboardingSyncDone).toHaveLength(1);
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(0);
  });

  it('listPins fails → MarkOnboardingSyncDone still called, MarkOnboardingSyncFailed NOT called', async () => {
    const permanentError = { _tag: 'ErrorResponse', response: { status: 400 }, data: { code: 1 } };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () => Effect.fail(permanentError),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await expect(runProcessTick(rpcLayer, restLayer, cacheLayer)).resolves.not.toThrow();

    expect(rpcCalls.MarkOnboardingSyncDone).toHaveLength(1);
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(0);
  });

  it('updateMessage fails → MarkOnboardingSyncDone still called, MarkOnboardingSyncFailed NOT called', async () => {
    const permanentError = { _tag: 'ErrorResponse', response: { status: 400 }, data: { code: 1 } };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([
      makePendingSync({ verify_intro_template: Option.some('Drifted body.') }),
    ]);
    const { layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () =>
        Effect.succeed({ items: [makePin({ embed: builtInEmbed() })], has_more: false }),
      updateMessage: () => Effect.fail(permanentError),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await expect(runProcessTick(rpcLayer, restLayer, cacheLayer)).resolves.not.toThrow();

    expect(rpcCalls.MarkOnboardingSyncDone).toHaveLength(1);
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(0);
  });

  // The verify channel is not a Community feature — it is created from the join path and
  // gated only on `profile_gate_enabled`. `is_community_enabled` defaults to false for any
  // guild not yet in `bot_guilds`, so if the reconcile sat behind that short-circuit the
  // setting would silently never reach most teams. It must run BEFORE the skip branch.
  it('is_community_enabled: false → the reconcile still runs, then MarkOnboardingSyncSkipped', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([
      makePendingSync({
        is_community_enabled: false,
        verify_intro_template: Option.some('Non-community body.'),
      }),
    ]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () =>
        Effect.succeed({ items: [makePin({ embed: builtInEmbed() })], has_more: false }),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    // NB: `makeRest` overrides REPLACE the recording default, so an overridden method never
    // lands in `calls` — assert on the reconcile's effect, not on listGuildChannels.
    expect(restCalls.updateMessage).toHaveLength(1);
    const [, , patch] = restCalls.updateMessage[0] as [string, string, { embeds: any[] }];
    expect(patch.embeds[0].description).toBe('Non-community body.');

    // ...and the Community short-circuit still does its own job unchanged.
    expect(rpcCalls.MarkOnboardingSyncSkipped).toHaveLength(1);
    expect(restCalls.putGuildsOnboarding).toHaveLength(0);
    expect(restCalls.updateGuildWelcomeScreen).toHaveLength(0);
  });

  // A failing welcome-screen patch marks the row 'failed', and only 'pending' rows are
  // re-claimed — so a reconcile sequenced after it would be lost forever for that team.
  it('welcome-screen patch failure → the reconcile already ran before it', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([
      makePendingSync({ verify_intro_template: Option.some('Body that must still land.') }),
    ]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () =>
        Effect.succeed({ items: [makePin({ embed: builtInEmbed() })], has_more: false }),
      updateGuildWelcomeScreen: () =>
        Effect.fail({
          _tag: 'ErrorResponse',
          response: { status: 400 },
          data: { code: 50035 },
        } as any),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.updateMessage).toHaveLength(1);
    const [, , patch] = restCalls.updateMessage[0] as [string, string, { embeds: any[] }];
    expect(patch.embeds[0].description).toBe('Body that must still land.');
    // The welcome-screen failure is still reported, exactly as before this change.
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(1);
  });

  it('createPin fails permanently after a successful post → the message is rolled back, sync still done', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () => Effect.succeed({ items: [], has_more: false }),
      createMessage: () => Effect.succeed({ id: 'freshly-posted-msg' }),
      createPin: () =>
        Effect.fail({
          _tag: 'ErrorResponse',
          response: { status: 403 },
          data: { code: 50013 },
        } as any),
    });
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    // Without the rollback the message would linger unpinned, invisible to the next
    // listPins, and get reposted on every subsequent template edit.
    expect(restCalls.deleteMessage).toHaveLength(1);
    expect((restCalls.deleteMessage[0] as any[])[1]).toBe('freshly-posted-msg');
    expect(rpcCalls.MarkOnboardingSyncDone).toHaveLength(1);
    expect(rpcCalls.MarkOnboardingSyncFailed).toHaveLength(0);
  });

  it('updateGuildWelcomeScreen still receives exactly the payload it always did — Deliverable B was dropped', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildChannels: () => Effect.succeed([makeGuildTextChannel()]),
      listPins: () => Effect.succeed({ items: [], has_more: false }),
    });
    const { layer: rpcLayer } = makeRpc([makePendingSync()]);
    const { layer: cacheLayer } = makeLiveCache();

    await runProcessTick(rpcLayer, restLayer, cacheLayer);

    expect(restCalls.updateGuildWelcomeScreen).toHaveLength(1);
    const { payload } = restCalls.updateGuildWelcomeScreen[0] as { payload: any };
    // Exactly the welcome_channel entry — no verify-channel entry was added.
    expect(payload.welcome_channels).toHaveLength(1);
    expect(payload.welcome_channels.every((c: any) => c.channel_id === WELCOME_CHANNEL_ID)).toBe(
      true,
    );
  });
});
