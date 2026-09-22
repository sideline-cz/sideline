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
 * `ChatAgent`, `ChatRateLimiter` and `AiActionProposalsRepository`
 * (`applications/server/src/services/ChatAgent.ts`,
 * `applications/server/src/services/ChatRateLimiter.ts`,
 * `applications/server/src/repositories/AiActionProposalsRepository.ts`) are noop-mocked here —
 * the last one became a new ambient dependency once the AI write path (`propose_create_event` /
 * `confirmProposal` / `rejectProposal`) landed, and cascades exactly like the other two.
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
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import { ChatAgent } from '~/services/ChatAgent.js';
import { ChatRateLimiter } from '~/services/ChatRateLimiter.js';

/**
 * Always degrades with `provider_error` and never resolves any reference, and never ships a
 * pending write (`proposal: Option.none()` — a degraded turn never ships a card, plan §16). A
 * test that accidentally exercises the AI chat endpoint under this mock gets an
 * obviously-wrong-but-safe 200 response (never a throw, never a crash of an unrelated suite)
 * rather than a partially constructed value — same rationale as `weeklyChallengeMocks.ts`'s
 * noop shape.
 */
export const MockChatAgentLayer = Layer.succeed(ChatAgent, {
  respond: () =>
    Effect.succeed({
      answer: '',
      generated: false,
      degradedReason: Option.some('provider_error'),
      references: [],
      proposal: Option.none(),
    }),
} as never);

/**
 * Always reports "not limited" (`Option.none()`) so an unrelated suite never observes a 429 from
 * a shared in-process counter leaking state across tests.
 */
export const MockChatRateLimiterLayer = Layer.succeed(ChatRateLimiter, {
  check: () => Effect.succeed(Option.none()),
} as never);

/**
 * `AiActionProposalsRepository` — new ambient dependency of `ApiLive` (`ChatAgent`'s own
 * construction binds it, and `ai-chat.ts`'s `confirmProposal`/`rejectProposal` handlers resolve
 * it directly) — see this file's header comment for why every `ApiLive`-providing test file
 * cascades off this mock. Every method dies: no test outside `ai-chat.test.ts` /
 * `ChatAgent.test.ts` (which script their own, behaviourally real, mocks) exercises the AI write
 * path, so an unrelated suite hitting one of these is a bug in that suite, not a silent noop —
 * matching `EventsRepository.insertEvent`'s `Effect.die(new Error('Not implemented'))` idiom
 * used throughout this same mock cascade for write methods nobody outside their own feature
 * tests should ever call.
 */
export const MockAiActionProposalsRepositoryLayer = Layer.succeed(AiActionProposalsRepository, {
  lockForConfirm: () => Effect.die(new Error('Not implemented')),
  claim: () => Effect.die(new Error('Not implemented')),
  insert: () => Effect.die(new Error('Not implemented')),
  deleteForUser: () => Effect.die(new Error('Not implemented')),
} as never);
