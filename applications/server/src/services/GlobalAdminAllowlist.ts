import { Effect, Layer, ServiceMap } from 'effect';
import { globalAdminDiscordIds } from '~/env.js';

export interface GlobalAdminAllowlistShape {
  readonly asEffect: Effect.Effect<ReadonlySet<string>>;
}

export class GlobalAdminAllowlist extends ServiceMap.Service<
  GlobalAdminAllowlist,
  GlobalAdminAllowlistShape
>()('api/GlobalAdminAllowlist') {
  static readonly Default = Layer.sync(GlobalAdminAllowlist, () => ({
    asEffect: Effect.succeed(globalAdminDiscordIds),
  }));
}
