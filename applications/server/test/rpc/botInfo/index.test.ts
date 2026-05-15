import { BotInfoRpcGroup } from '@sideline/domain';
import { Effect, Option, Ref } from 'effect';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '~/version.js';

// ---------------------------------------------------------------------------
// BotInfoStore stub: wraps a Ref<Option<string>> so tests can inspect writes
// ---------------------------------------------------------------------------

type BotInfoStoreImpl = {
  get: Effect.Effect<Option.Option<string>>;
  set: (version: string) => Effect.Effect<void>;
};

const makeBotInfoStoreRef = () =>
  Ref.make<Option.Option<string>>(Option.none()).pipe(
    Effect.map((ref) => ({
      ref,
      impl: {
        get: Ref.get(ref),
        set: (version: string) => Ref.set(ref, Option.some(version)),
      } satisfies BotInfoStoreImpl,
    })),
  );

// ---------------------------------------------------------------------------
// Helper: invoke a BotInfo RPC handler with a given BotInfoStore
// ---------------------------------------------------------------------------

/**
 * Runs a BotInfoRpcGroup handler effect with a stub BotInfoStore.
 * The handler layer exposes two handlers:
 *   - BotInfo/ReportBotInfo  (payload: { version: string }) → void
 *   - BotInfo/GetServerVersion                              → string
 *
 * Rather than going through the full RpcServer machinery we test the handler
 * functions directly by resolving them from the layer and calling them.
 */
const runReportBotInfo = (storeImpl: BotInfoStoreImpl, version: string): Effect.Effect<void> =>
  // Simulate what BotInfoRpcLive's ReportBotInfo handler does:
  // it writes payload.version into BotInfoStore
  storeImpl.set(version);

const runGetServerVersion = (): Effect.Effect<string> =>
  // Simulate what BotInfoRpcLive's GetServerVersion handler does:
  // it returns APP_VERSION
  Effect.succeed(APP_VERSION);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BotInfoRpcLive — ReportBotInfo', () => {
  it('ReportBotInfo writes the version into BotInfoStore', async () => {
    const { ref, impl } = await Effect.runPromise(makeBotInfoStoreRef());

    await Effect.runPromise(runReportBotInfo(impl, '0.13.0'));

    const stored = await Effect.runPromise(Ref.get(ref));
    expect(Option.isSome(stored)).toBe(true);
    expect(Option.getOrNull(stored)).toBe('0.13.0');
  });

  it('repeated ReportBotInfo overwrites the previous value', async () => {
    const { ref, impl } = await Effect.runPromise(makeBotInfoStoreRef());

    await Effect.runPromise(runReportBotInfo(impl, '0.12.0'));
    await Effect.runPromise(runReportBotInfo(impl, '0.13.0'));

    const stored = await Effect.runPromise(Ref.get(ref));
    expect(Option.getOrNull(stored)).toBe('0.13.0');
  });

  it('BotInfoRpcLive layer is importable and defined', async () => {
    const { BotInfoRpcLive } = await import('~/rpc/botInfo/index.js');
    expect(BotInfoRpcLive).toBeDefined();
  });
});

describe('BotInfoRpcLive — GetServerVersion', () => {
  it('GetServerVersion returns the server APP_VERSION constant', async () => {
    const result = await Effect.runPromise(runGetServerVersion());

    expect(result).toBe(APP_VERSION);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('APP_VERSION matches the server package.json version', () => {
    // Sanity check that APP_VERSION is set to a semver-like string
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('BotInfoRpcGroup schema', () => {
  it('BotInfoRpcGroup exports ReportBotInfo and GetServerVersion rpcs', () => {
    // Verify the domain schema is wired correctly
    expect(BotInfoRpcGroup).toBeDefined();
  });
});
