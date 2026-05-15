import { Effect, Layer, Option, Ref, ServiceMap } from 'effect';

export interface BotInfoStoreShape {
  readonly get: Effect.Effect<Option.Option<string>>;
  readonly set: (version: string) => Effect.Effect<void>;
}

const make: Effect.Effect<BotInfoStoreShape> = Ref.make<Option.Option<string>>(Option.none()).pipe(
  Effect.map((ref) => ({
    get: Ref.get(ref),
    set: (version: string) => Ref.set(ref, Option.some(version)),
  })),
);

export class BotInfoStore extends ServiceMap.Service<BotInfoStore, BotInfoStoreShape>()(
  'api/BotInfoStore',
) {
  static readonly Default = Layer.effect(BotInfoStore, make);
}
