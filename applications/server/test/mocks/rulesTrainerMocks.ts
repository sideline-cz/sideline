import { Effect, Layer } from 'effect';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';

/**
 * A noop mock for RulesAttemptsRepository used in tests that don't exercise
 * the rules-trainer endpoints. All methods return safe empty/void values.
 */
export const MockRulesAttemptsRepositoryLayer = Layer.succeed(RulesAttemptsRepository, {
  _tag: 'api/RulesAttemptsRepository' as const,
  insertAttempt: () =>
    Effect.die(new Error('MockRulesAttemptsRepository.insertAttempt not implemented')),
  insertResults: () => Effect.void,
  lastCorrectByScenario: () => Effect.succeed([]),
  lastCorrectByScenarioForTeam: () => Effect.succeed([]),
  getExamStats: () => Effect.succeed({ exams_completed: 0, perfect_exams: 0 }),
} as never);
