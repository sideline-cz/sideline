import { Effect, Layer, Option, Ref, ServiceMap } from 'effect';

export interface BotInfoStoreShape {
  readonly get: Effect.Effect<Option.Option<string>>;
  readonly set: (version: string) => Effect.Effect<void>;
}

const make: Effect.Effect<BotInfoStoreShape> = Ref.make<Option.Option<string>>(Option.none()).pipe(
  Effect.map((ref) => ({
    get: Ref.get(ref),
    // `Ref.set` yields the underlying ref (not `undefined`) at runtime in this
    // Effect v4 beta; without `asVoid` the ReportBotInfo RPC (Void success) fails
    // to encode the handler result ("Expected void, got MutableRef…") — which
    // surfaced as a "Failed to report bot version" warning on every startup.
    set: (version: string) => Ref.set(ref, Option.some(version)).pipe(Effect.asVoid),
  })),
);

export class BotInfoStore extends ServiceMap.Service<BotInfoStore, BotInfoStoreShape>()(
  'api/BotInfoStore',
) {
  static readonly Default = Layer.effect(BotInfoStore, make);
}
