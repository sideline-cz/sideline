// NOTE: TDD tests written before implementation.
// The InviteCache service does not yet exist. Tests will fail with
// "cannot find module" or similar until Phase 5 implementation.

import { Effect, type Layer, type Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { InviteCache } from '~/services/InviteCache.js';

// The service interface that will be implemented in Phase 5
interface InviteCacheService {
  upsert(guildId: string, code: string, uses: number): Effect.Effect<void>;
  remove(guildId: string, code: string): Effect.Effect<void>;
  snapshot(guildId: string): Effect.Effect<Map<string, number>>;
  diffOnMemberJoin(
    guildId: string,
    fresh: ReadonlyArray<{ code: string; uses: number }>,
  ): Effect.Effect<Option.Option<string>>;
}

const g1 = 'guild-1';
const g2 = 'guild-2';

// InviteCache is any (module not found until Phase 5).
// Cast Default to a layer that provides nothing (will be replaced by real impl).
const InviteCacheDefaultLayer = InviteCache.Default as Layer.Layer<never, never, never>;

// Helper to get the service — the returned effect is cast to R=never since
// InviteCache.asEffect() returns any when the module is missing.
const withCache = <A>(f: (c: InviteCacheService) => Effect.Effect<A>): Effect.Effect<A> =>
  (InviteCache.asEffect() as Effect.Effect<InviteCacheService>).pipe(Effect.andThen(f));

describe('InviteCache', () => {
  it('upsert then snapshot returns Map with the entry', async () => {
    await Effect.runPromise(
      Effect.Do.pipe(
        Effect.tap(() => withCache((c) => c.upsert(g1, 'A', 1))),
        Effect.bind('snap', () => withCache((c) => c.snapshot(g1))),
        Effect.tap(({ snap }) =>
          Effect.sync(() => {
            expect(snap.get('A')).toBe(1);
          }),
        ),
        Effect.provide(InviteCacheDefaultLayer),
      ),
    );
  });

  it('upsert overwrites existing entry', async () => {
    await Effect.runPromise(
      Effect.Do.pipe(
        Effect.tap(() => withCache((c) => c.upsert(g1, 'A', 1))),
        Effect.tap(() => withCache((c) => c.upsert(g1, 'A', 2))),
        Effect.bind('snap', () => withCache((c) => c.snapshot(g1))),
        Effect.tap(({ snap }) =>
          Effect.sync(() => {
            expect(snap.get('A')).toBe(2);
          }),
        ),
        Effect.provide(InviteCacheDefaultLayer),
      ),
    );
  });

  it('remove(g1, A) makes snapshot empty', async () => {
    await Effect.runPromise(
      Effect.Do.pipe(
        Effect.tap(() => withCache((c) => c.upsert(g1, 'A', 1))),
        Effect.tap(() => withCache((c) => c.remove(g1, 'A'))),
        Effect.bind('snap', () => withCache((c) => c.snapshot(g1))),
        Effect.tap(({ snap }) =>
          Effect.sync(() => {
            expect(snap.size).toBe(0);
          }),
        ),
        Effect.provide(InviteCacheDefaultLayer),
      ),
    );
  });

  it('snapshot for untouched guild g2 → empty Map', async () => {
    await Effect.runPromise(
      Effect.Do.pipe(
        Effect.tap(() => withCache((c) => c.upsert(g1, 'A', 1))),
        Effect.bind('snap', () => withCache((c) => c.snapshot(g2))),
        Effect.tap(({ snap }) =>
          Effect.sync(() => {
            expect(snap.size).toBe(0);
          }),
        ),
        Effect.provide(InviteCacheDefaultLayer),
      ),
    );
  });

  it('diffOnMemberJoin replaces snapshot with fresh contents', async () => {
    const fresh = [
      { code: 'A', uses: 2 },
      { code: 'B', uses: 1 },
    ];
    await Effect.runPromise(
      Effect.Do.pipe(
        Effect.tap(() => withCache((c) => c.upsert(g1, 'A', 1))),
        Effect.bind('diffResult', () => withCache((c) => c.diffOnMemberJoin(g1, fresh))),
        Effect.bind('snap', () => withCache((c) => c.snapshot(g1))),
        Effect.tap(({ snap }) =>
          Effect.sync(() => {
            expect(snap.get('A')).toBe(2);
            expect(snap.get('B')).toBe(1);
          }),
        ),
        Effect.provide(InviteCacheDefaultLayer),
      ),
    );
  });
});
