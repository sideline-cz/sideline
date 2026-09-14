import { Effect, Layer, ServiceMap } from 'effect';
import { aiChatEnabled } from '~/env.js';

/**
 * Injectable wrapper around the `AI_CHAT_ENABLED` kill switch (plan
 * `.work-plans/ai-app-interaction.md` §10), modelled verbatim on
 * `DiscordJoinEnforcementConfig` — same `{ asEffect: Effect.Effect<boolean> }` shape, same
 * `.Default` reading a module-level env-parsed constant.
 *
 * `env.ts` snapshots `process.env` at import time, so `vi.stubEnv` is a no-op against it once
 * the module has loaded — per `applications/server/AGENTS.md` → "Injectable Env-Derived Config
 * Service", wrapping the flag in a service is what lets `ai-chat.test.ts` toggle it between
 * `TestLayer` variants within one process.
 */
export interface AiChatEnabledConfigShape {
  readonly asEffect: Effect.Effect<boolean>;
}

export class AiChatEnabledConfig extends ServiceMap.Service<
  AiChatEnabledConfig,
  AiChatEnabledConfigShape
>()('api/AiChatEnabledConfig') {
  static readonly Default = Layer.sync(AiChatEnabledConfig, () => ({
    asEffect: Effect.succeed(aiChatEnabled),
  }));
}
