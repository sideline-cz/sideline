import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option } from 'effect';
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';

export const MockFeesRepositoryLayer = Layer.succeed(FeesRepository, {
  _tag: 'api/FeesRepository' as const,
  insert: () => LogicError.die('MockFeesRepositoryLayer.insert not implemented'),
  findById: () => Effect.succeed(Option.none()),
  findByIdActive: () => Effect.succeed(Option.none()),
  findWithCountsById: () => Effect.succeed(Option.none()),
  listByTeam: () => Effect.succeed([]),
  update: () => LogicError.die('MockFeesRepositoryLayer.update not implemented'),
  archive: () => Effect.void,
  insertAssignmentForTest: () => Effect.void,
  delete_: () => Effect.void,
  countAssignmentsByFeeId: () => Effect.succeed(0),
} as never);

export const MockFeeAssignmentsRepositoryLayer = Layer.succeed(FeeAssignmentsRepository, {
  _tag: 'api/FeeAssignmentsRepository' as const,
  findById: () => Effect.succeed(Option.none()),
  findByFee: () => Effect.succeed([]),
  findByTeamMember: () => Effect.succeed([]),
  findByFeeAndMember: () => Effect.succeed(Option.none()),
  bulkInsert: () => Effect.succeed([]),
  update: () => LogicError.die('MockFeeAssignmentsRepositoryLayer.update not implemented'),
  findReminderCandidates: () => Effect.succeed([]),
  findUnpaidAssignmentsForUser: () => Effect.succeed([]),
} as never);

export const MockPaymentsRepositoryLayer = Layer.succeed(PaymentsRepository, {
  _tag: 'api/PaymentsRepository' as const,
  insert: () => LogicError.die('MockPaymentsRepositoryLayer.insert not implemented'),
  findById: () => Effect.succeed(Option.none()),
  findActiveById: () => Effect.succeed(Option.none()),
  void_: () => Effect.succeed(Option.none()),
  listByTeam: () => Effect.succeed([]),
  hardDeleteForTest: () => Effect.void,
} as never);

export const MockFinanceOverviewRepositoryLayer = Layer.succeed(FinanceOverviewRepository, {
  _tag: 'api/FinanceOverviewRepository' as const,
  overviewByTeam: () => Effect.succeed([]),
  myStatus: () => Effect.succeed([]),
} as never);

export const MockExpensesRepositoryLayer = Layer.succeed(ExpensesRepository, {
  _tag: 'api/ExpensesRepository' as const,
  insert: () => LogicError.die('MockExpensesRepositoryLayer.insert not implemented'),
  findById: () => Effect.succeed(Option.none()),
  listByTeam: () => Effect.succeed([]),
  update: () => Effect.succeed(Option.none()),
  delete: () => Effect.succeed(false),
  balanceSummaryByTeam: () =>
    Effect.succeed([
      {
        currency: 'CZK',
        incomeMinor: 0,
        expensesMinor: 0,
        netMinor: 0,
        byCategory: [],
      },
    ]),
  countHistoryRows: () => Effect.succeed(0),
} as never);

export const MockFinanceLayers = Layer.mergeAll(
  MockFeesRepositoryLayer,
  MockFeeAssignmentsRepositoryLayer,
  MockPaymentsRepositoryLayer,
  MockFinanceOverviewRepositoryLayer,
  MockExpensesRepositoryLayer,
);
