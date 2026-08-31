// Tests for invite generator ProcessorService — processTick routing via `Invite/PendingAcceptances`.
// Pattern: applications/bot/test/rcp/roleProvision/handleProvisionRole.test.ts.
//
// PR-2 (Discord onboarding fix, wire expand): `welcome_channel_id` is now `Option.Option<string>`.
// Test 6 below pins the new `welcome_channel_missing` short-circuit this PR makes reachable in
// code (it's unreachable in PRODUCTION this release — the server's temporary wire guard in
// `InviteAcceptancesRepository.findPending` keeps a null off the wire until PR-3).
//
// PR-3 (contract): the wire guard is lifted, `bot_present: false` is now reachable in production,
// and CC-0 / blocker 2 means a transient classification must never call
// `Invite/MarkAcceptanceFailed` — see the tests at the bottom of this file.

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

  // PR-3 test list item 14.
  it('marks the acceptance failed with bot_not_in_guild when bot_present is false', async () => {
    const acceptance = makeAcceptance({ bot_present: false });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createChannelInvite).toHaveLength(0);
    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'bot_not_in_guild',
    });
  });

  // PR-3 test list item 15 — pins the precedence: bot_not_in_guild is checked before the
  // welcome-channel branch, so a row missing both gets the more actionable code.
  it('prefers bot_not_in_guild over welcome_channel_missing when both are true', async () => {
    const acceptance = makeAcceptance({ bot_present: false, welcome_channel_id: Option.none() });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createChannelInvite).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'bot_not_in_guild',
    });
  });

  // PR-3 test list item 16 — blocker 2's regression test: a transient classification must leave
  // the row untouched (no MarkAcceptanceFailed call at all), so the next poll retries it.
  it('does NOT call MarkAcceptanceFailed for a RatelimitedResponse', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({
          _tag: 'RatelimitedResponse',
          message: 'You are being rate limited.',
          retry_after: 0,
          global: false,
        }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(0);
  });

  // PR-3 test list item 17 — regression: `RequestError` is a dead tag in this effect version (no
  // such `_tag` exists — see `HttpClientError.d.ts`). A genuine network failure actually arrives
  // as `{ _tag: 'HttpClientError', reason: { _tag: 'TransportError' } }`. Before this fix, that
  // shape fell through to `unknown` (terminal), which is precisely the blip that would
  // permanently kill this acceptance's invite — this is the regression that matters.
  it('does NOT call MarkAcceptanceFailed for an HttpClientError wrapping a TransportError (network)', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({
          _tag: 'HttpClientError',
          reason: { _tag: 'TransportError', description: 'ECONNREFUSED' },
        }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(0);
  });

  // PR-3 test list item 18 — regression: dfx never surfaces a real HTTP 5xx as `ErrorResponse`
  // (that tag is only used for 4xx); a 5xx arrives as `HttpClientError`/`StatusCodeError` with
  // the real status on `.response.status`.
  it('does NOT call MarkAcceptanceFailed for an HttpClientError/StatusCodeError with a 503', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({
          _tag: 'HttpClientError',
          reason: { _tag: 'StatusCodeError' },
          response: { status: 503 },
        }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(0);
  });

  // The terminal side of the same branch: an HttpClientError/StatusCodeError with a non-5xx
  // status is a client mistake, not Discord's outage, and must still call MarkAcceptanceFailed.
  it('DOES call MarkAcceptanceFailed for an HttpClientError/StatusCodeError with a 403', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({
          _tag: 'HttpClientError',
          reason: { _tag: 'StatusCodeError' },
          response: { status: 403 },
        }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'discord_error',
    });
  });

  // Fix regression: `ErrorResponse.code` is Discord's internal error code, not an HTTP status —
  // a code that happens to fall in the 500-599 range must not be treated as a server outage.
  it('DOES call MarkAcceptanceFailed for an ErrorResponse whose Discord code happens to be 500', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({ _tag: 'ErrorResponse', code: 500, message: 'Internal Server Error' }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.SetAcceptanceDiscordCode).toHaveLength(0);
    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'discord_error',
    });
  });

  // PR-3 test list item 19 — the terminal side of the same branch: a non-5xx (client mistake)
  // ErrorResponse must still call MarkAcceptanceFailed exactly as before.
  it('DOES call MarkAcceptanceFailed for a 50013 ErrorResponse', async () => {
    const acceptance = makeAcceptance();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({ _tag: 'ErrorResponse', code: 50013, message: 'Missing Permissions' }),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.MarkAcceptanceFailed).toHaveLength(1);
    expect(rpcCalls.MarkAcceptanceFailed[0]).toMatchObject({
      acceptance_id: ACCEPTANCE_ID,
      error_code: 'bot_missing_perms',
    });
  });

  // PR-3 test list item 20 — `retry_after` (capped) is honoured with a real sleep before the tick
  // returns, so a 429 burst doesn't immediately re-hammer Discord at 1 Hz. Uses a small
  // `retry_after` so the test itself stays fast.
  it('sleeps for retry_after (capped) before returning on a 429', async () => {
    const acceptance = makeAcceptance();
    const { layer: rpcLayer } = makeRpc([acceptance]);
    const { layer: restLayer } = makeRest({
      createChannelInvite: () =>
        Effect.fail({
          _tag: 'RatelimitedResponse',
          message: 'You are being rate limited.',
          retry_after: 0.1,
          global: false,
        }),
    });

    const start = performance.now();
    await runProcessTick(rpcLayer, restLayer);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeGreaterThanOrEqual(80);
  });
});
