/**
 * TDD tests for the `GuildMemberAdd` verify-prompt branch (Task 9) and the
 * unverified-role + read-only-channel self-heal (Task 10).
 *
 * There is no standalone `guildMemberAdd.ts` — the dispatch is inline in
 * `events/index.ts`'s `eventHandlers` (`handleWelcomeMeta`). Pattern mirrors
 * `test/events/guildMemberAdd.test.ts`: capture the registered dispatch
 * callback via a mocked `DiscordGateway.handleDispatch` and invoke it
 * directly, rather than importing a standalone handler function.
 *
 * Spec: .work-plans/discord-full-onboarding.md, Task 9 ("verify field +
 * button on the welcome embed") and Task 10 ("unverified role + read-only
 * verification channel"), "Test specification" §Task 9 and §Task 10.
 *
 * These tests are expected to FAIL until:
 *   - `handleWelcomeMeta` (events/index.ts) gains the `profile_complete` /
 *     `profile_gate_enabled` / `verify_locale` branch (Task 9), and
 *   - `~/services/VerificationChannelCache.js` and
 *     `~/rest/roles/ensureUnverifiedRole.js` exist and are wired into
 *     `eventHandlers` (Task 10).
 */

import { DiscordREST } from 'dfx/DiscordREST';
import { DiscordGateway } from 'dfx/gateway';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Logger, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { eventHandlers } from '~/events/index.js';
import { InviteCache } from '~/services/InviteCache.js';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { VerificationChannelCache } from '~/services/VerificationChannelCache.js';

const GUILD_ID = '111111111111111111';
const USER_ID = '222222222222222222';
const WELCOME_CHANNEL_ID = '333333333333333333';
const UNVERIFIED_ROLE_ID = '444444444444444444';
const VERIFY_CHANNEL_ID = '555555555555555555';

const makeMemberAddPayload = () => ({
  guild_id: GUILD_ID,
  user: { id: USER_ID, username: 'new-member', avatar: null, global_name: null, bot: false },
  roles: [] as string[],
  nick: null,
  joined_at: new Date().toISOString(),
  deaf: false,
  mute: false,
});

// ---------------------------------------------------------------------------
// RegisterMember DTO fixtures — top-level fields OUTSIDE `welcome`, per Task 4.
// ---------------------------------------------------------------------------

type WelcomeMeta = {
  system_log_channel_id: Option.Option<string>;
  invite_code: Option.Option<string>;
  welcome: Option.Option<{
    welcome_channel_id: Option.Option<string>;
    welcome_message_rendered: Option.Option<string>;
    group_name: Option.Option<string>;
    group_color_int: Option.Option<number>;
    inviter_discord_id: Option.Option<string>;
  }>;
  profile_complete: boolean;
  profile_gate_enabled: boolean;
  verify_locale: 'en' | 'cs';
};

const withWelcome = (overrides: Partial<WelcomeMeta> = {}): Option.Option<WelcomeMeta> =>
  Option.some({
    system_log_channel_id: Option.none(),
    invite_code: Option.none(),
    welcome: Option.some({
      welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
      welcome_message_rendered: Option.some('Welcome to the team!'),
      group_name: Option.none(),
      group_color_int: Option.none(),
      inviter_discord_id: Option.none(),
    }),
    profile_complete: true,
    profile_gate_enabled: false,
    verify_locale: 'en',
    ...overrides,
  });

const withoutWelcome = (overrides: Partial<WelcomeMeta> = {}): Option.Option<WelcomeMeta> =>
  Option.some({
    system_log_channel_id: Option.none(),
    invite_code: Option.none(),
    welcome: Option.none(),
    profile_complete: false,
    profile_gate_enabled: true,
    verify_locale: 'en',
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

const makeGatewayLayer = () => {
  let capturedHandler: ((payload: unknown) => Effect.Effect<unknown, unknown, unknown>) | undefined;
  const layer = Layer.succeed(DiscordGateway, {
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
  return { layer, getHandler: () => capturedHandler };
};

type RestOverrides = {
  createMessage?: (...args: never[]) => Effect.Effect<unknown, unknown>;
  listGuildRoles?: (...args: never[]) => Effect.Effect<unknown, unknown>;
  createGuildRole?: (...args: never[]) => Effect.Effect<unknown, unknown>;
  addGuildMemberRole?: (...args: never[]) => Effect.Effect<unknown, unknown>;
  deleteGuildMemberRole?: (...args: never[]) => Effect.Effect<unknown, unknown>;
  listGuildChannels?: (...args: never[]) => Effect.Effect<unknown, unknown>;
  createGuildChannel?: (...args: never[]) => Effect.Effect<unknown, unknown>;
  getGuild?: (...args: never[]) => Effect.Effect<unknown, unknown>;
};

const makeRestLayer = (overrides: RestOverrides = {}) => {
  const rest = new Proxy({} as any, {
    get: (_target: unknown, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      if (prop === 'listGuildInvites') return () => Effect.succeed([]);
      if (prop in overrides) return (overrides as Record<string, unknown>)[prop];
      if (prop === 'listGuildRoles') return () => Effect.succeed([]);
      if (prop === 'listGuildChannels') return () => Effect.succeed([]);
      return () => Effect.succeed(undefined);
    },
  });
  return Layer.succeed(DiscordREST, rest);
};

const makeRpcLayer = (welcomeMeta: Option.Option<WelcomeMeta>) =>
  Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        if (prop === 'Guild/RegisterMember') return () => Effect.succeed(welcomeMeta);
        return () => Effect.void;
      },
    }),
  );

// `eventHandlers` needs the three caches as well as the gateway/REST/RPC trio, so the
// cast below has to name them — erasing them made `Effect.provide(testLayer)` leave
// `InviteCache | OnboardingRoleCache` in the requirements channel.
type TestEnv =
  | DiscordGateway
  | DiscordREST
  | SyncRpc
  | InviteCache
  | OnboardingRoleCache
  | VerificationChannelCache;

const makeTestLayer = (
  gatewayLayer: Layer.Layer<DiscordGateway>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  extra: ReadonlyArray<Layer.Layer<never>> = [],
) =>
  Layer.mergeAll(
    gatewayLayer,
    restLayer,
    rpcLayer,
    InviteCache.Default,
    OnboardingRoleCache.Default,
    VerificationChannelCache.Default,
    ...extra,
  ) as unknown as Layer.Layer<TestEnv>;

const runMemberAdd = async (
  getHandler: () => ((payload: unknown) => Effect.Effect<unknown, unknown, unknown>) | undefined,
  testLayer: Layer.Layer<TestEnv>,
) => {
  await Effect.runPromise(eventHandlers.pipe(Effect.asVoid, Effect.provide(testLayer)));
  const handler = getHandler();
  expect(handler).toBeDefined();
  await Effect.runPromise(
    (handler as (payload: unknown) => Effect.Effect<unknown, unknown, unknown>)(
      makeMemberAddPayload(),
    ).pipe(Effect.provide(testLayer)) as Effect.Effect<unknown, never, never>,
  );
};

// ---------------------------------------------------------------------------
// Task 9 — verify field + button on the welcome embed
// ---------------------------------------------------------------------------

describe('GuildMemberAdd — Task 9 verify prompt on the welcome embed', () => {
  it('profile_complete: true → exactly the messages sent today, no verify button', async () => {
    const createMessage = (_channelId: string, body: { components?: unknown }) => {
      createMessageCalls.push(body);
      return Effect.succeed({ id: 'msg-1' });
    };
    const createMessageCalls: Array<{ components?: unknown }> = [];
    const restLayer = makeRestLayer({ createMessage });
    const rpcLayer = makeRpcLayer(
      withWelcome({ profile_complete: true, profile_gate_enabled: true }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    expect(createMessageCalls).toHaveLength(1);
    expect(createMessageCalls[0]?.components).toBeUndefined();
  });

  it('profile_gate_enabled: false → no button even with profile_complete: false', async () => {
    const createMessageCalls: Array<{ components?: unknown }> = [];
    const restLayer = makeRestLayer({
      createMessage: (_c: string, body: { components?: unknown }) => {
        createMessageCalls.push(body);
        return Effect.succeed({ id: 'msg-1' });
      },
    });
    const rpcLayer = makeRpcLayer(
      withWelcome({ profile_complete: false, profile_gate_enabled: false }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    expect(createMessageCalls).toHaveLength(1);
    expect(createMessageCalls[0]?.components).toBeUndefined();
  });

  it('incomplete + gate on + welcome present → ONE createMessage carrying the field + button', async () => {
    const createMessageCalls: Array<{
      embeds?: ReadonlyArray<{ fields?: ReadonlyArray<{ name: string }> }>;
      components?: unknown;
      allowed_mentions?: { parse: string[]; users?: string[] };
    }> = [];
    const restLayer = makeRestLayer({
      createMessage: (_c: string, body: (typeof createMessageCalls)[number]) => {
        createMessageCalls.push(body);
        return Effect.succeed({ id: 'msg-1' });
      },
    });
    const rpcLayer = makeRpcLayer(
      withWelcome({ profile_complete: false, profile_gate_enabled: true }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    expect(createMessageCalls).toHaveLength(1);
    const call = createMessageCalls[0];
    expect(call?.components).toBeDefined();
    expect(call?.allowed_mentions?.parse).toEqual([]);
    expect(call?.allowed_mentions?.users).toContain(USER_ID);
  });

  it('incomplete + gate on + welcome: None (plain-invite cohort) → posts NOTHING', async () => {
    const createMessageCalls: unknown[] = [];
    const restLayer = makeRestLayer({
      createMessage: (_c: string, body: unknown) => {
        createMessageCalls.push(body);
        return Effect.succeed({ id: 'msg-1' });
      },
    });
    const rpcLayer = makeRpcLayer(
      withoutWelcome({ profile_complete: false, profile_gate_enabled: true }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    expect(createMessageCalls).toHaveLength(0);
  });

  it('verify_locale drives the strings — cs on the DTO, no getGuild call', async () => {
    const getGuild = () => Effect.succeed({ id: GUILD_ID, preferred_locale: 'en-US' });
    const createMessageCalls: Array<{
      embeds?: ReadonlyArray<{ fields?: ReadonlyArray<{ name: string; value: string }> }>;
    }> = [];
    const restLayer = makeRestLayer({
      createMessage: (_c: string, body: (typeof createMessageCalls)[number]) => {
        createMessageCalls.push(body);
        return Effect.succeed({ id: 'msg-1' });
      },
      getGuild,
    });
    const rpcLayer = makeRpcLayer(
      withWelcome({ profile_complete: false, profile_gate_enabled: true, verify_locale: 'cs' }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    // `guild_locale` doesn't exist on GuildMemberAdd — bot AGENTS.md forbids a
    // getGuild call to resolve join-time strings. `verify_locale` on the DTO
    // is the only source.
    expect(createMessageCalls).toHaveLength(1);
  });

  it('an old server response missing all three keys → decodes safe defaults, nothing posted', async () => {
    // Simulates a pre-Task-4 server: the success payload has no
    // `profile_complete` / `profile_gate_enabled` / `verify_locale` keys at
    // all. The domain schema's `withDecodingDefaultKey` defaults apply
    // upstream of the bot (profile_complete: true, profile_gate_enabled:
    // false) — this fixture models that decoded shape arriving at the bot.
    const createMessageCalls: unknown[] = [];
    const restLayer = makeRestLayer({
      createMessage: (_c: string, body: unknown) => {
        createMessageCalls.push(body);
        return Effect.succeed({ id: 'msg-1' });
      },
    });
    const rpcLayer = makeRpcLayer(
      withWelcome({ profile_complete: true, profile_gate_enabled: false }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    // Exactly the welcome message, no button.
    expect(createMessageCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Task 10 — unverified role self-heal on GuildMemberAdd
// ---------------------------------------------------------------------------

describe('GuildMemberAdd — Task 10 unverified role self-heal', () => {
  it('incomplete + gate on → role granted (addGuildMemberRole called)', async () => {
    const addGuildMemberRole = { calls: [] as unknown[][] };
    const restLayer = makeRestLayer({
      listGuildRoles: () =>
        Effect.succeed([{ id: UNVERIFIED_ROLE_ID, name: 'Sideline Unverified' }]),
      listGuildChannels: () =>
        Effect.succeed([{ id: VERIFY_CHANNEL_ID, name: 'nez-zacnes', type: 0 }]),
      addGuildMemberRole: (...args: unknown[]) => {
        addGuildMemberRole.calls.push(args);
        return Effect.succeed(undefined);
      },
    });
    const rpcLayer = makeRpcLayer(
      withoutWelcome({ profile_complete: false, profile_gate_enabled: true }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    expect(addGuildMemberRole.calls).toHaveLength(1);
  });

  it('complete + gate on → deleteGuildMemberRole called, createGuildRole NOT called (web-writer self-heal)', async () => {
    const deleteGuildMemberRole = { calls: [] as unknown[][] };
    const createGuildRole = { calls: [] as unknown[][] };
    const restLayer = makeRestLayer({
      listGuildRoles: () =>
        Effect.succeed([{ id: UNVERIFIED_ROLE_ID, name: 'Sideline Unverified' }]),
      createGuildRole: (...args: unknown[]) => {
        createGuildRole.calls.push(args);
        return Effect.succeed({ id: UNVERIFIED_ROLE_ID, name: 'Sideline Unverified' });
      },
      deleteGuildMemberRole: (...args: unknown[]) => {
        deleteGuildMemberRole.calls.push(args);
        return Effect.succeed(undefined);
      },
    });
    const rpcLayer = makeRpcLayer(
      withWelcome({ profile_complete: true, profile_gate_enabled: true }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    expect(deleteGuildMemberRole.calls).toHaveLength(1);
    expect(createGuildRole.calls).toHaveLength(0);
  });

  it('gate off → neither addGuildMemberRole nor deleteGuildMemberRole is called', async () => {
    const addGuildMemberRole = { calls: [] as unknown[][] };
    const deleteGuildMemberRole = { calls: [] as unknown[][] };
    const restLayer = makeRestLayer({
      addGuildMemberRole: (...args: unknown[]) => {
        addGuildMemberRole.calls.push(args);
        return Effect.succeed(undefined);
      },
      deleteGuildMemberRole: (...args: unknown[]) => {
        deleteGuildMemberRole.calls.push(args);
        return Effect.succeed(undefined);
      },
    });
    const rpcLayer = makeRpcLayer(
      withWelcome({ profile_complete: false, profile_gate_enabled: false }),
    );
    const gateway = makeGatewayLayer();
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer);

    await runMemberAdd(gateway.getHandler, testLayer);

    expect(addGuildMemberRole.calls).toHaveLength(0);
    expect(deleteGuildMemberRole.calls).toHaveLength(0);
  });

  it('MANAGE_ROLES missing → a warning is logged, the join still succeeds', async () => {
    const permissionError = {
      _tag: 'ErrorResponse',
      response: { status: 403 },
      data: { code: 50013 },
    };
    const restLayer = makeRestLayer({
      listGuildRoles: () => Effect.fail(permissionError),
      createGuildRole: () => Effect.fail(permissionError),
    });
    const rpcLayer = makeRpcLayer(
      withoutWelcome({ profile_complete: false, profile_gate_enabled: true }),
    );
    const gateway = makeGatewayLayer();

    const messages: string[] = [];
    const loggerLayer = Logger.layer([
      Logger.make((options) => {
        messages.push(String(options.message));
      }),
    ]);
    const testLayer = makeTestLayer(gateway.layer, restLayer, rpcLayer, [loggerLayer]);

    // The join must resolve — never fail — even though every role/channel
    // REST call permanently fails.
    await expect(runMemberAdd(gateway.getHandler, testLayer)).resolves.toBeUndefined();

    expect(messages.some((m) => m.toLowerCase().includes('role'))).toBe(true);
  });
});
