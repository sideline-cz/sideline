import { Effect, Layer, Option } from 'effect';
import { WeeklyChallengeRepository } from '~/repositories/WeeklyChallengeRepository.js';

/**
 * A noop mock for WeeklyChallengeRepository used in tests that don't exercise
 * the weekly-challenge endpoints. All methods return safe empty/void values.
 */
export const MockWeeklyChallengeRepositoryLayer = Layer.succeed(WeeklyChallengeRepository, {
  _tag: 'api/WeeklyChallengeRepository' as const,
  listForTeam: () => Effect.succeed({ team: { id: 'noop', timezone: 'UTC' }, challenges: [] }),
  findById: () => Effect.succeed(Option.none()),
  create: () => Effect.die(new Error('MockWeeklyChallengeRepository.create not implemented')),
  updateTitleDescription: () =>
    Effect.die(new Error('MockWeeklyChallengeRepository.updateTitleDescription not implemented')),
  delete: () => Effect.void,
  markCompleted: () => Effect.void,
  unmarkCompleted: () => Effect.void,
  enqueueAnnouncementEvent: () => Effect.void,
  listUnprocessedDueEvents: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);
