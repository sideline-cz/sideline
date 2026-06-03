import { Effect, Layer, Option } from 'effect';
import { CarpoolsRepository } from '~/repositories/CarpoolsRepository.js';

/**
 * A noop mock for CarpoolsRepository used in tests that don't exercise
 * the carpool endpoints. All methods return safe empty/void values.
 */
export const MockCarpoolsRepositoryLayer = Layer.succeed(CarpoolsRepository, {
  _tag: 'api/CarpoolsRepository' as const,
  createCarpool: () =>
    Effect.die(new Error('MockCarpoolsRepository.createCarpool not implemented')),
  saveMessageId: () => Effect.void,
  findCarpoolView: () => Effect.succeed(Option.none()),
  addCar: () => Effect.die(new Error('MockCarpoolsRepository.addCar not implemented')),
  saveCarThreadId: () => Effect.void,
  reserveSeat: () => Effect.void,
  leaveSeat: () => Effect.void,
  removeCar: () => Effect.die(new Error('MockCarpoolsRepository.removeCar not implemented')),
  findCarById: () => Effect.succeed(Option.none()),
} as never);

export const MockCarpoolsRepositoryLayerEmpty = MockCarpoolsRepositoryLayer;
