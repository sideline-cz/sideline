import type { Translations } from '@sideline/domain';
import { Effect, Layer } from 'effect';
import { TranslationsRepository } from '~/repositories/TranslationsRepository.js';
import { TranslationCache } from '~/services/TranslationCache.js';

export const MockTranslationCacheLayer = Layer.succeed(TranslationCache, {
  _tag: 'api/TranslationCache' as const,
  get: () =>
    Effect.succeed({
      version: 1,
      overrides: [] as ReadonlyArray<Translations.TranslationOverride>,
    }),
  refresh: () => Effect.void,
} as never);

export const MockTranslationsRepositoryLayer = Layer.succeed(TranslationsRepository, {
  _tag: 'api/TranslationsRepository' as const,
  findAll: () => Effect.succeed([] as ReadonlyArray<Translations.TranslationOverride>),
  getVersion: () => Effect.succeed(1),
  upsert: () => Effect.succeed(1),
  delete_: () => Effect.succeed(1),
  importMerge: () => Effect.succeed(1),
} as never);

export const MockTranslationsLayers = Layer.merge(
  MockTranslationCacheLayer,
  MockTranslationsRepositoryLayer,
);
