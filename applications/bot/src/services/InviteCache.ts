import { Effect, Layer, type Option, Ref, ServiceMap } from 'effect';
import { inviteDiff } from '~/services/inviteDiff.js';

export class InviteCache extends ServiceMap.Service<
  InviteCache,
  {
    readonly upsert: (guildId: string, code: string, uses: number) => Effect.Effect<void>;
    readonly remove: (guildId: string, code: string) => Effect.Effect<void>;
    readonly snapshot: (guildId: string) => Effect.Effect<Map<string, number>>;
    readonly diffOnMemberJoin: (
      guildId: string,
      fresh: ReadonlyArray<{ readonly code: string; readonly uses: number }>,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()('bot/InviteCache') {
  static readonly Default: Layer.Layer<InviteCache> = Layer.effect(
    InviteCache,
    Ref.make(new Map<string, Map<string, number>>()).pipe(
      Effect.map((storeRef) => ({
        upsert: (guildId: string, code: string, uses: number): Effect.Effect<void> =>
          Ref.update(storeRef, (store) => {
            const next = new Map(store);
            const guild = new Map(next.get(guildId) ?? []);
            guild.set(code, uses);
            next.set(guildId, guild);
            return next;
          }),

        remove: (guildId: string, code: string): Effect.Effect<void> =>
          Ref.update(storeRef, (store) => {
            const existing = store.get(guildId);
            if (existing === undefined) return store;
            const next = new Map(store);
            const guild = new Map(existing);
            guild.delete(code);
            next.set(guildId, guild);
            return next;
          }),

        snapshot: (guildId: string): Effect.Effect<Map<string, number>> =>
          Ref.get(storeRef).pipe(
            Effect.map((store) => store.get(guildId) ?? new Map<string, number>()),
          ),

        diffOnMemberJoin: (
          guildId: string,
          fresh: ReadonlyArray<{ readonly code: string; readonly uses: number }>,
        ): Effect.Effect<Option.Option<string>> =>
          Ref.modify(storeRef, (store) => {
            const before = store.get(guildId) ?? new Map<string, number>();
            const winner = inviteDiff(before, fresh);
            // Replace the guild snapshot with the fresh data regardless of result.
            const next = new Map(store);
            const freshMap = new Map<string, number>();
            for (const { code, uses } of fresh) {
              freshMap.set(code, uses);
            }
            next.set(guildId, freshMap);
            return [winner, next];
          }),
      })),
    ),
  );
}
