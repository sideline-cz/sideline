import { Effect, Layer, Option, Ref, ServiceMap } from 'effect';

const TTL_MS = 60_000;

export class OnboardingRoleCache extends ServiceMap.Service<
  OnboardingRoleCache,
  {
    readonly get: (guildId: string) => Effect.Effect<Option.Option<Option.Option<string>>>;
    readonly set: (guildId: string, value: Option.Option<string>) => Effect.Effect<void>;
    readonly invalidate: (guildId: string) => Effect.Effect<void>;
  }
>()('bot/OnboardingRoleCache') {
  static readonly Default: Layer.Layer<OnboardingRoleCache> = Layer.effect(
    OnboardingRoleCache,
    Ref.make(new Map<string, { value: Option.Option<string>; expiresAt: number }>()).pipe(
      Effect.map((storeRef) => ({
        get: (guildId: string): Effect.Effect<Option.Option<Option.Option<string>>> =>
          Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
            Effect.flatMap((now) =>
              Ref.get(storeRef).pipe(
                Effect.map((store) => {
                  const entry = store.get(guildId);
                  if (entry === undefined || now > entry.expiresAt) return Option.none();
                  return Option.some(entry.value);
                }),
              ),
            ),
          ),

        set: (guildId: string, value: Option.Option<string>): Effect.Effect<void> =>
          Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
            Effect.flatMap((now) =>
              Ref.update(storeRef, (store) => {
                const next = new Map(store);
                next.set(guildId, { value, expiresAt: now + TTL_MS });
                return next;
              }),
            ),
          ),

        invalidate: (guildId: string): Effect.Effect<void> =>
          Ref.update(storeRef, (store) => {
            const next = new Map(store);
            next.delete(guildId);
            return next;
          }),
      })),
    ),
  );
}
