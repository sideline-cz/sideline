import { Effect, Layer, Option, Ref, ServiceMap } from 'effect';

const TTL_MS = 60_000;

export type VerificationChannelEntry = {
  readonly roleId: string;
  readonly channelId: string;
};

/**
 * Per-guild cache of `{ roleId, channelId }` for the Task 10 unverified role +
 * read-only channel, so a `guildMemberAdd` doesn't pay a `listGuildRoles` +
 * `listGuildChannels` round trip on every single join. Copy of
 * `OnboardingRoleCache`'s shape (60s TTL, no negative caching beyond the TTL).
 */
export class VerificationChannelCache extends ServiceMap.Service<
  VerificationChannelCache,
  {
    readonly get: (guildId: string) => Effect.Effect<Option.Option<VerificationChannelEntry>>;
    readonly set: (guildId: string, value: VerificationChannelEntry) => Effect.Effect<void>;
    readonly invalidate: (guildId: string) => Effect.Effect<void>;
  }
>()('bot/VerificationChannelCache') {
  static readonly Default: Layer.Layer<VerificationChannelCache> = Layer.effect(
    VerificationChannelCache,
    Ref.make(new Map<string, { value: VerificationChannelEntry; expiresAt: number }>()).pipe(
      Effect.map((storeRef) => ({
        get: (guildId: string): Effect.Effect<Option.Option<VerificationChannelEntry>> =>
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

        set: (guildId: string, value: VerificationChannelEntry): Effect.Effect<void> =>
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
