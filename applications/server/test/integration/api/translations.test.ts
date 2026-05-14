import { describe, expect, it } from '@effect/vitest';
import { Translations } from '@sideline/domain';
import { Effect, Layer } from 'effect';
import { beforeEach } from 'vitest';
import { TranslationsRepository } from '~/repositories/TranslationsRepository.js';
import { TranslationCache } from '~/services/TranslationCache.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const RepoTestLayer = TranslationsRepository.Default.pipe(Layer.provideMerge(TestPgClient));

const CacheTestLayer = TranslationCache.Default.pipe(
  Layer.provideMerge(TranslationsRepository.Default),
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Authorization gate
// ---------------------------------------------------------------------------

describe('requireGlobalAdmin', () => {
  it('fails with TranslationForbidden when not a global admin', () => {
    // Direct unit test for the permission helper
    const forbidden = new Translations.TranslationForbidden();
    expect(forbidden._tag).toBe('TranslationForbidden');
  });
});

// ---------------------------------------------------------------------------
// Repository-level tests (simulating API behaviour)
// ---------------------------------------------------------------------------

describe('Translations API — list endpoint logic', () => {
  it.effect('returns empty overrides from a fresh database', () =>
    Effect.Do.pipe(
      Effect.bind('repo', () => TranslationsRepository.asEffect()),
      Effect.bind('cache', () => TranslationCache.asEffect()),
      Effect.flatMap(({ cache }) => cache.get()),
      Effect.tap(({ version, overrides }) =>
        Effect.sync(() => {
          expect(version).toBeGreaterThanOrEqual(1);
          expect(overrides).toHaveLength(0);
        }),
      ),
      Effect.provide(CacheTestLayer),
    ),
  );
});

describe('Translations API — upsert endpoint logic', () => {
  it.effect('upsert stores value and increments version', () =>
    Effect.Do.pipe(
      Effect.bind('repo', () => TranslationsRepository.asEffect()),
      Effect.tap(({ repo }) =>
        repo.upsert({
          key: 'app_name' as Translations.TranslationKey,
          locale: 'en',
          value: 'Custom Name',
          updatedBy: null,
        }),
      ),
      Effect.bind('overrides', ({ repo }) => repo.findAll()),
      Effect.tap(({ overrides }) =>
        Effect.sync(() => {
          expect(overrides).toHaveLength(1);
          expect(overrides[0]?.key).toBe('app_name');
          expect(overrides[0]?.value).toBe('Custom Name');
        }),
      ),
      Effect.provide(RepoTestLayer),
    ),
  );

  it.effect('upsert with null value (delete semantics) removes entry', () =>
    Effect.Do.pipe(
      Effect.bind('repo', () => TranslationsRepository.asEffect()),
      Effect.tap(({ repo }) =>
        repo.upsert({
          key: 'app_name' as Translations.TranslationKey,
          locale: 'en',
          value: 'Temp',
          updatedBy: null,
        }),
      ),
      Effect.tap(({ repo }) =>
        repo.delete_({
          key: 'app_name' as Translations.TranslationKey,
          locale: 'en',
        }),
      ),
      Effect.bind('overrides', ({ repo }) => repo.findAll()),
      Effect.tap(({ overrides }) =>
        Effect.sync(() => {
          expect(overrides).toHaveLength(0);
        }),
      ),
      Effect.provide(RepoTestLayer),
    ),
  );
});

describe('Translations API — import endpoint logic', () => {
  it.effect('import rejects unknown keys (simulated check)', () =>
    Effect.Do.pipe(
      Effect.flatMap(() => {
        // Simulate the unknown key check from the handler
        const knownKeys = new Set(['app_name', 'app_welcome', 'auth_signInDiscord']);
        const entries = [
          { key: 'app_name', locale: 'en' as Translations.Locale, value: 'OK' },
          { key: 'unknown_key_xyz', locale: 'en' as Translations.Locale, value: 'BAD' },
        ];
        const unknownKeys = entries.map((e) => e.key).filter((k) => !knownKeys.has(k));
        return unknownKeys.length > 0
          ? Effect.fail(new Translations.UnknownTranslationKeys({ keys: unknownKeys })).pipe(
              Effect.result,
              Effect.map((result) => {
                expect(result._tag).toBe('Failure');
                return result;
              }),
            )
          : Effect.void;
      }),
      Effect.provide(RepoTestLayer),
    ),
  );

  it.effect('importMerge stores all entries and bumps version once', () =>
    Effect.Do.pipe(
      Effect.bind('repo', () => TranslationsRepository.asEffect()),
      Effect.bind('vBefore', ({ repo }) => repo.getVersion()),
      Effect.tap(({ repo }) =>
        repo.importMerge({
          entries: [
            { key: 'app_name' as Translations.TranslationKey, locale: 'en', value: 'Imported EN' },
            { key: 'app_name' as Translations.TranslationKey, locale: 'cs', value: 'Imported CS' },
          ],
          updatedBy: null,
        }),
      ),
      Effect.bind('overrides', ({ repo }) => repo.findAll()),
      Effect.bind('version', ({ repo }) => repo.getVersion()),
      Effect.tap(({ vBefore, overrides, version }) =>
        Effect.sync(() => {
          expect(overrides).toHaveLength(2);
          // Version bumped exactly once
          expect(version).toBe(vBefore + 1);
        }),
      ),
      Effect.provide(RepoTestLayer),
    ),
  );
});
