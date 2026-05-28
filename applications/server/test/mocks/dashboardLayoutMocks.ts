import { Effect, Layer, Option } from 'effect';
import { DashboardLayoutsRepository } from '~/repositories/DashboardLayoutsRepository.js';

/**
 * A noop mock for DashboardLayoutsRepository used in tests that don't exercise
 * the dashboard-layout endpoints. All methods return safe empty/void values.
 */
export const MockDashboardLayoutsRepositoryLayer = Layer.succeed(DashboardLayoutsRepository, {
  _tag: 'api/DashboardLayoutsRepository' as const,
  findByUserTeam: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('MockDashboardLayoutsRepository.upsert not implemented')),
} as never);
