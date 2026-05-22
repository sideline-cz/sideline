import { Effect, Layer, Option } from 'effect';
import { TeamOnboardingTokensRepository } from '~/repositories/TeamOnboardingTokensRepository.js';

/**
 * Stub layer for TeamOnboardingTokensRepository — returns safe defaults for all methods.
 * Used in test suites that wire ApiLive but do not test onboarding endpoints directly.
 */
export const MockTeamOnboardingTokensRepositoryLayer = Layer.succeed(
  TeamOnboardingTokensRepository,
  {
    _tag: 'api/TeamOnboardingTokensRepository',
    create: () =>
      Effect.die(new Error('TeamOnboardingTokensRepository.create: not implemented in stub')),
    findByHash: () => Effect.succeed(Option.none()),
    findById: () => Effect.succeed(Option.none()),
    markConsumed: () => Effect.succeed(Option.none()),
    revoke: () => Effect.void,
    listForAdmin: () => Effect.succeed([]),
  } as never,
);
