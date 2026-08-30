// Tests for invite generator ProcessorService — processTick routing via `Invite/PendingAcceptances`.
// Pattern: applications/bot/test/rcp/roleProvision/handleProvisionRole.test.ts.
//
// PR-2 (Discord onboarding fix, wire expand): `welcome_channel_id` is now `Option.Option<string>`.
// Test 6 below pins the new `welcome_channel_missing` short-circuit this PR makes reachable in
// code (it's unreachable in PRODUCTION this release — the server's temporary wire guard in
// `InviteAcceptancesRepository.findPending` keeps a null off the wire until PR-3).

import type { InviteAcceptance } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProcessorService } from '~/rcp/inviteGenerator/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCEPTANCE_ID = 'acceptance-1' as InviteAcceptance.InviteAcceptanceId;
const GUILD_ID = '111111111111111111';
const CHANNEL_ID = '222222222222222222';

// ---------------------------------------------------------------------------
// SyncRpc mock
// ---------------------------------------------------------------------------

type PendingAcceptanceFixture = {
  readonly acceptance_id: InviteAcceptance.InviteAcceptanceId;
  readonly guild_id: string;
  readonly welcome_channel_id: Option.Option<string>;
  readonly bot_present: boolean;
};

type RpcCalls = {
  PendingAcceptances: unknown[][];
  SetAcceptanceDiscordCode: Array<{ acceptance_id: string; discord_code: string }>;
  MarkAcceptanceFailed: Array<{ acceptance_id: string; error_code: string; error_detail: string }>;
};

const makeRpc = (
  acceptances: PendingAcceptanceFixture[] = [],
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = {
    PendingAcceptances: [],
    SetAcceptanceDiscordCode: [],
    MarkAcceptanceFailed: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Invite/PendingAcceptances': (...args: any[]) => {
      calls.PendingAcceptances.push(args);
      return Effect.succeed(acceptances);
    },
    'Invite/SetAcceptanceDiscordCode': (args: { acceptance_id: string; discord_code: string }) => {
      calls.SetAcceptanceDiscordCode.push(args);
      return Effect.void;
    },
    'Invite/MarkAcceptanceFailed': (args: {
      acceptance_id: string;
      error_code: string;
      error_detail: string;
    }) => {
      calls.MarkAcceptanceFailed.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) throw new Error(`Unmocked RPC method: ${prop}`);
        return fn;
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// DiscordREST mock
// ---------------------------------------------------------------------------

type RestCalls = {
  createChannelInvite: unknown[][];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = { createChannelInvite: [] };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createChannelInvite: (...args: any[]) => {
      calls.createChannelInvite.push(args);
      return Effect.succeed({ code: 'generated-code' });
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) return () => Effect.void;
        return fn;
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Fixture + run helpers
// ---------------------------------------------------------------------------

const makeAcceptance = (
  overrides: Partial<PendingAcceptanceFixture> = {},
): PendingAcceptanceFixture => ({
  acceptance_id: ACCEPTANCE_ID,
  guild_id: GUILD_ID,
  welcome_channel_id: Option.some(CHANNEL_ID),
  bot_present: true,
  ...overrides,
});

const runProcessTick = (
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
): Promise<void> =>
  Effect.runPromise(
    ProcessorService.pipe(
      Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
      Effect.provide(Layer.merge(rpcLayer, restLayer)),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('inviteGenerator ProcessorService — processTick', () => {
  // PR-2 test list item 6.
  it('marks the acceptance failed with welcome_channel_missing when welcome_channel_id is None', async () => {
    const acceptance = makeAcceptance({ welcome_channel_id: Option.none() });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createChannelInvite).toHaveLength(0);
    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'welcome_channel_missing',
    });
  });

  // PR-2 test list item 7.
  it('sets the discord code on success', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createChannelInvite).toHaveLength(1);
    expect(restCalls.createChannelInvite[0][0]).toBe(CHANNEL_ID);
    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(1);
    expect(rpcCalls.SetAcceptanceDiscordCode[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      discord_code: 'generated-code',
    });
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(0);
  });

  // PR-2 test list item 8.
  it('classifies a 50013 ErrorResponse as bot_missing_perms', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({ _tag: 'ErrorResponse', code: 50013, message: 'Missing Permissions' }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'bot_missing_perms',
    });
  });

  // PR-2 test list item 9 — proves the community gate belongs at the Discord boundary, not SQL.
  it('classifies a Discord "community" error as community_not_enabled', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({
          _tag: 'ErrorResponse',
          code: 50035,
          message: 'Invalid Form Body: this server must be a community server',
        }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'community_not_enabled',
    });
  });
});
