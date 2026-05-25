import { Effect, Layer, Option } from 'effect';
import { TeamChallengeRepository } from '~/repositories/TeamChallengeRepository.js';

/**
 * A noop mock for TeamChallengeRepository used in tests that don't exercise
 * the team-challenge endpoints. All methods return safe empty/void values.
 */
export const MockTeamChallengeRepositoryLayer = Layer.succeed(TeamChallengeRepository, {
  _tag: 'api/TeamChallengeRepository' as const,
  listForTeam: () => Effect.succeed({ team: { id: 'noop', timezone: 'UTC' }, challenges: [] }),
  findById: () => Effect.succeed(Option.none()),
  create: () => Effect.die(new Error('MockTeamChallengeRepository.create not implemented')),
  updateTitleDescription: () =>
    Effect.die(new Error('MockTeamChallengeRepository.updateTitleDescription not implemented')),
  delete: () =>
    Effect.die(new Error('MockTeamChallengeRepositoryLayer: delete called unexpectedly')),
  markCompleted: () =>
    Effect.die(new Error('MockTeamChallengeRepositoryLayer: markCompleted called unexpectedly')),
  unmarkCompleted: () =>
    Effect.die(new Error('MockTeamChallengeRepositoryLayer: unmarkCompleted called unexpectedly')),
  enqueueAnnouncementEvent: () =>
    Effect.die(
      new Error('MockTeamChallengeRepositoryLayer: enqueueAnnouncementEvent called unexpectedly'),
    ),
  listUnprocessedDueEvents: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);
