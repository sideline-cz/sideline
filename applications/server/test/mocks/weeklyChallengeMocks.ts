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
  delete: () =>
    Effect.die(new Error('MockWeeklyChallengeRepositoryLayer: delete called unexpectedly')),
  markCompleted: () =>
    Effect.die(new Error('MockWeeklyChallengeRepositoryLayer: markCompleted called unexpectedly')),
  unmarkCompleted: () =>
    Effect.die(
      new Error('MockWeeklyChallengeRepositoryLayer: unmarkCompleted called unexpectedly'),
    ),
  enqueueAnnouncementEvent: () =>
    Effect.die(
      new Error('MockWeeklyChallengeRepositoryLayer: enqueueAnnouncementEvent called unexpectedly'),
    ),
  listUnprocessedDueEvents: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);
