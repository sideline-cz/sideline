import { Effect, Layer, Ref, Semaphore, ServiceMap } from 'effect';

export interface ChannelReorderSemaphoreService {
  /** Acquire the per-channel mutex, run `effect`, then release. */
  withChannelLock: (
    channelId: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class ChannelReorderSemaphore extends ServiceMap.Service<
  ChannelReorderSemaphore,
  ChannelReorderSemaphoreService
>()('bot/ChannelReorderSemaphore') {
  static readonly Live: Layer.Layer<ChannelReorderSemaphore> = Layer.effect(
    ChannelReorderSemaphore,
    Ref.make(new Map<string, Semaphore.Semaphore>()).pipe(
      Effect.map((registryRef) => {
        // Atomically get-or-create the per-channel semaphore so concurrent
        // callers on the same channelId always observe the same instance.
        const getOrCreate = (channelId: string): Effect.Effect<Semaphore.Semaphore> =>
          Semaphore.make(1).pipe(
            Effect.flatMap((fresh) =>
              Ref.modify(registryRef, (registry) => {
                const existing = registry.get(channelId);
                if (existing !== undefined) return [existing, registry];
                const next = new Map(registry);
                next.set(channelId, fresh);
                return [fresh, next];
              }),
            ),
          );

        return {
          withChannelLock:
            (channelId: string) =>
            <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
              getOrCreate(channelId).pipe(
                Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)),
              ),
        };
      }),
    ),
  );
}
