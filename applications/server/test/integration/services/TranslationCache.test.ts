import { describe, expect, it } from '@effect/vitest';
import type { Translations } from '@sideline/domain';
import { Effect, Layer } from 'effect';
import { beforeEach } from 'vitest';
import { TranslationsRepository } from '~/repositories/TranslationsRepository.js';
import { TranslationCache } from '~/services/TranslationCache.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = TranslationCache.Default.pipe(
  Layer.provideMerge(TranslationsRepository.Default),
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

describe('TranslationCache', () => {
  it.effect('initialises with empty overrides and version from DB', () =>
    Effect.Do.pipe(
      Effect.bind('cache', () => TranslationCache.asEffect()),
      Effect.flatMap(({ cache }) => cache.get()),
      Effect.tap(({ version, overrides }) =>
        Effect.sync(() => {
          expect(version).toBeGreaterThanOrEqual(1);
          expect(overrides).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('refresh picks up new repository writes', () =>
    Effect.Do.pipe(
      Effect.bind('repo', () => TranslationsRepository.asEffect()),
      Effect.bind('cache', () => TranslationCache.asEffect()),
      // Write via repository directly (bypasses cache)
      Effect.tap(({ repo }) =>
        repo.upsert({
          key: 'app_name' as Translations.TranslationKey,
          locale: 'en',
          value: 'After Write',
          updatedBy: null,
        }),
      ),
      // Manually refresh cache
      Effect.tap(({ cache }) => cache.refresh()),
      // Check cache now has the new value
      Effect.flatMap(({ cache }) => cache.get()),
      Effect.tap(({ overrides }) =>
        Effect.sync(() => {
          const found = overrides.find((o) => o.key === 'app_name' && o.locale === 'en');
          expect(found).toBeDefined();
          expect(found?.value).toBe('After Write');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('version increments after two writes', () =>
    Effect.Do.pipe(
      Effect.bind('repo', () => TranslationsRepository.asEffect()),
      Effect.bind('cache', () => TranslationCache.asEffect()),
      Effect.bind('v1', ({ cache }) => cache.get().pipe(Effect.map((s) => s.version))),
      Effect.tap(({ repo }) =>
        repo.upsert({
          key: 'app_name' as Translations.TranslationKey,
          locale: 'en',
          value: 'First',
          updatedBy: null,
        }),
      ),
      Effect.tap(({ repo }) =>
        repo.upsert({
          key: 'app_welcome' as Translations.TranslationKey,
          locale: 'cs',
          value: 'Vitej',
          updatedBy: null,
        }),
      ),
      Effect.tap(({ cache }) => cache.refresh()),
      Effect.flatMap(({ cache }) => cache.get()),
      Effect.tap(({ version }) =>
        Effect.sync(() => {
          // After 2 writes, version should be at least initial + 2
          expect(version).toBeGreaterThanOrEqual(3);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
