import { PgClient } from '@effect/sql-pg';
import type { Translations } from '@sideline/domain';
import { Effect, Layer, Ref, Schedule, ServiceMap, Stream } from 'effect';
import { TranslationsRepository } from '~/repositories/TranslationsRepository.js';

interface CacheState {
  readonly version: number;
  readonly overrides: ReadonlyArray<Translations.TranslationOverride>;
}

export interface CacheSnapshot {
  readonly version: number;
  readonly overrides: ReadonlyArray<Translations.TranslationOverride>;
}

export interface TranslationCacheShape {
  readonly get: () => Effect.Effect<CacheSnapshot>;
  readonly refresh: () => Effect.Effect<void>;
}

const make: Effect.Effect<
  TranslationCacheShape,
  never,
  TranslationsRepository | PgClient.PgClient
> = Effect.Do.pipe(
  Effect.bind('repository', () => TranslationsRepository.asEffect()),
  Effect.bind('pgClient', () => PgClient.PgClient.asEffect()),
  Effect.bind('initialOverrides', ({ repository }) => repository.findAll()),
  Effect.bind('initialVersion', ({ repository }) => repository.getVersion()),
  Effect.bind('stateRef', ({ initialOverrides, initialVersion }) =>
    Ref.make<CacheState>({
      version: initialVersion,
      overrides: initialOverrides,
    }),
  ),
  Effect.let(
    'refresh',
    ({ repository, stateRef }) =>
      (): Effect.Effect<void> =>
        Effect.Do.pipe(
          Effect.bind('overrides', () => repository.findAll()),
          Effect.bind('version', () => repository.getVersion()),
          Effect.tap(({ overrides, version }) => Ref.set(stateRef, { version, overrides })),
          Effect.asVoid,
          Effect.tapError((e) => Effect.logWarning('TranslationCache: refresh failed', e)),
          Effect.ignore,
        ),
  ),
  Effect.tap(({ pgClient, refresh }) =>
    // Background fiber: LISTEN for NOTIFY translation_cache_invalidate and refresh the cache.
    // PgClient.listen returns a Stream<string, SqlError>; we consume each notification and
    // refresh. We wrap in Effect.retry with exponential back-off so the listener
    // auto-reconnects when the pg connection drops.
    pgClient.listen('translation_cache_invalidate').pipe(
      Stream.tap((_payload) =>
        refresh().pipe(
          Effect.tap(() => Effect.logDebug('TranslationCache: refreshed after NOTIFY')),
        ),
      ),
      Stream.runDrain,
      Effect.retry(Schedule.exponential('1 second', 2).pipe(Schedule.take(20))),
      Effect.tapError((e) =>
        Effect.logError('TranslationCache: LISTEN fiber stopped unexpectedly', e),
      ),
      Effect.ignore,
      Effect.forkScoped,
    ),
  ),
  Effect.map(({ stateRef, refresh }) => ({
    get: (): Effect.Effect<CacheSnapshot> => Ref.get(stateRef),
    refresh,
  })),
) as Effect.Effect<TranslationCacheShape, never, TranslationsRepository | PgClient.PgClient>;

export class TranslationCache extends ServiceMap.Service<TranslationCache, TranslationCacheShape>()(
  'api/TranslationCache',
) {
  // Layer.effect provides Scope automatically, allowing forkScoped inside make
  static readonly Default = Layer.effect(TranslationCache, make);
}
