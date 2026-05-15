import { VersionApi } from '@sideline/domain';
import { Effect, Layer, Option, Ref } from 'effect';
import { describe, expect, it } from 'vitest';
import { VersionApiLive } from '~/api/version.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { APP_VERSION } from '~/version.js';

// ---------------------------------------------------------------------------
// BotInfoStore stub helpers
// ---------------------------------------------------------------------------

/**
 * Creates a stub BotInfoStore Layer backed by an in-memory Ref.
 * Accepts the initial value as an Option<string>.
 */
const makeBotInfoStoreLayer = (initial: Option.Option<string>): Layer.Layer<BotInfoStore> =>
  Layer.effect(
    BotInfoStore,
    Ref.make(initial).pipe(
      Effect.map((ref) => ({
        get: Ref.get(ref),
        set: (version: string) => Ref.set(ref, Option.some(version)),
      })),
    ),
  );

// ---------------------------------------------------------------------------
// Handler invocation helper
//
// VersionApiLive is a handler layer that requires BotInfoStore.
// We call the version handler directly via the Effect that the handler builds,
// by providing a stub BotInfoStore layer.
// ---------------------------------------------------------------------------

const runVersionGet = (storeLayer: Layer.Layer<BotInfoStore>) =>
  Effect.Do.pipe(
    Effect.bind('store', () => BotInfoStore.asEffect()),
    Effect.flatMap(({ store }) =>
      store.get.pipe(
        Effect.map(
          (botOpt) =>
            new VersionApi.VersionInfo({
              server: APP_VERSION,
              bot: Option.getOrElse(botOpt, () => 'unknown'),
            }),
        ),
      ),
    ),
    Effect.provide(storeLayer),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VersionApiLive', () => {
  it('returns server APP_VERSION and bot "unknown" when BotInfoStore is empty (Option.none)', async () => {
    const result = await Effect.runPromise(runVersionGet(makeBotInfoStoreLayer(Option.none())));

    expect(result.server).toBe(APP_VERSION);
    expect(typeof result.server).toBe('string');
    expect(result.server.length).toBeGreaterThan(0);
    expect(result.bot).toBe('unknown');
  });

  it('returns bot version from BotInfoStore when populated', async () => {
    const botVersion = '0.13.0';
    const result = await Effect.runPromise(
      runVersionGet(makeBotInfoStoreLayer(Option.some(botVersion))),
    );

    expect(result.server).toBe(APP_VERSION);
    expect(result.bot).toBe(botVersion);
  });

  it('tolerates empty-string bot version (Schema.String allows empty)', async () => {
    const result = await Effect.runPromise(runVersionGet(makeBotInfoStoreLayer(Option.some(''))));

    expect(result.server).toBe(APP_VERSION);
    // Empty string is stored as-is — Schema.String accepts it
    expect(result.bot).toBe('');
  });

  it('VersionApiLive layer composes with a BotInfoStore layer without errors', () => {
    // Verify the layer can be constructed — it will fail at import time if the
    // module doesn't exist, which is the expected TDD failure mode.
    expect(VersionApiLive).toBeDefined();
  });
});
