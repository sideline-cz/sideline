import { Effect, Layer, Option } from 'effect';
import { PlayerRatingsRepository } from '~/repositories/PlayerRatingsRepository.js';

/**
 * A noop mock for PlayerRatingsRepository used in tests that don't exercise
 * the player-rating endpoints. Reads return empty/none; writes are no-ops.
 */
export const MockPlayerRatingsRepositoryLayer = Layer.succeed(PlayerRatingsRepository, {
  _tag: 'api/PlayerRatingsRepository' as const,
  getMemberRating: () => Effect.succeed(Option.none()),
  getTeamRatings: () => Effect.succeed([]),
  findHistoryByMember: () => Effect.succeed([]),
  getOrInitMany: () => Effect.succeed([]),
  applyGameUpdates: () => Effect.void,
} as never);
