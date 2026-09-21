/**
 * Noop mock layers for the read-only AI assistant's services — plan
 * `.work-plans/ai-app-interaction.md` §7/§10/§13.6.
 *
 * Per `applications/server/AGENTS.md` → "HttpApi Mock-Layer Cascade": once `AiChatApiGroup` is
 * wired into `ApiLive` (`applications/server/src/api/api.ts` + `applications/server/src/api/
 * index.ts`), EVERY test file that builds `ApiLive` — directly or transitively — must provide a
 * layer for every service the group's handlers depend on, even tests that never touch the AI
 * endpoints. This file is the mechanical fix for the ~55 existing `ApiLive`-providing test files
 * (`grep -rl ApiLive applications/server/test`), modelled on the canonical noop-mock shape in
 * `weeklyChallengeMocks.ts` / `teamChallengeMocks.ts` / `onboardingMocks.ts`.
 *
 * `ChatAgent` and `ChatRateLimiter` (`applications/server/src/services/ChatAgent.ts`,
 * `applications/server/src/services/ChatRateLimiter.ts`) are noop-mocked here.
 *
 * `LlmClient` and `AiChatEnabledConfig` are NOT re-exported here. `LlmClient.Default` already
 * requires no services (`src/services/LlmClient.ts` — `Effect.serviceOption(HttpClient.HttpClient)`
 * makes it self-contained) and defaults to the deterministic stub when no `HttpClient` layer is
 * present, which is the safe default for a suite that does not exercise AI chat. Likewise
 * `AiChatEnabledConfig.Default` (see the design note in `applications/server/test/api/
 * ai-chat.test.ts`'s header comment — this service's shape is this tester's own inference from
 * the "Injectable Env-Derived Config Service" pattern (`applications/server/AGENTS.md`), not one
 * pinned by the plan text) reads the env-parsed
 * `aiChatEnabled` constant directly, which defaults to `false` (disabled) — also safe for an
 * unrelated suite. Cascading callers should add `Layer.provide(LlmClient.Default)` and
 * `Layer.provide(AiChatEnabledConfig.Default)` alongside the two mocks below, mirroring how
 * `BotInfoStore.Default` / `DiscordJoinEnforcementConfig.Default` are threaded through
 * `activity-type.test.ts`'s `TestLayer` today.
 */
import { Effect, Layer, Option } from 'effect';
import { ChatAgent } from '~/services/ChatAgent.js';
import { ChatRateLimiter } from '~/services/ChatRateLimiter.js';

/**
 * Always degrades with `provider_error` and never resolves any reference. A test that
 * accidentally exercises the AI chat endpoint under this mock gets an obviously-wrong-but-safe
 * 200 response (never a throw, never a crash of an unrelated suite) rather than a partially
 * constructed value — same rationale as `weeklyChallengeMocks.ts`'s noop shape.
 */
export const MockChatAgentLayer = Layer.succeed(ChatAgent, {
  respond: () =>
    Effect.succeed({
      answer: '',
      generated: false,
      degradedReason: Option.some('provider_error'),
      references: [],
    }),
} as never);

/**
 * Always reports "not limited" (`Option.none()`) so an unrelated suite never observes a 429 from
 * a shared in-process counter leaking state across tests.
 */
export const MockChatRateLimiterLayer = Layer.succeed(ChatRateLimiter, {
  check: () => Effect.succeed(Option.none()),
} as never);
