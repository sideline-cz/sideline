// Mock layers for the Fio bank-sync repositories, in the canonical noop shape used across this
// test suite (see `test/mocks/emailMocks.ts`): `Effect.succeed(Option.none())` / `Effect.succeed([])`
// / `Effect.void` for reads, `Effect.die(...)` for non-trivial writes a given test does not
// itself exercise, and an `as never` cast on the mock object (sanctioned by
// `applications/server/AGENTS.md`).
//
// Plan `.work-plans/fio-transaction-matching.md` §7.3: "Every file from
// `grep -rl ApiLive applications/server/test` must provide them." That cross-cutting wiring
// (~40 existing test files gaining these mocks in their `ApiLive`-composing layer) is part of the
// IMPLEMENTATION task (T6's definition of done), not this file — this file only defines the
// mocks themselves, ready for the developer to merge into `AppLive`'s test doubles.
//
// This file will not compile until `applications/server/src/repositories/BankSyncConfigRepository.ts`
// and `applications/server/src/repositories/BankTransactionsRepository.ts` exist.

import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { FioSecretCrypto } from '~/services/FioSecretCrypto.js';

const die = (msg: string) => () => Effect.die(new Error(msg));

export const MockBankSyncConfigRepositoryLayer = Layer.succeed(BankSyncConfigRepository, {
  _tag: 'api/BankSyncConfigRepository' as const,
  findByTeam: () => Effect.succeed(Option.none()),
  upsert: die('MockBankSyncConfigRepository.upsert not implemented'),
  findPollable: () => Effect.succeed([]),
  claimPollLease: () => Effect.succeed(Option.none()),
  releasePollLease: () => Effect.void,
  claimRematchLease: () => Effect.succeed(Option.none()),
  releaseRematchLease: () => Effect.void,
  reserveThrottleSlot: die('MockBankSyncConfigRepository.reserveThrottleSlot not implemented'),
  recordSuccess: () => Effect.void,
  recordFailure: () => Effect.void,
  recordCoverageGap: () => Effect.void,
  upsertStatementPeriod: die('MockBankSyncConfigRepository.upsertStatementPeriod not implemented'),
  updateBackfillProgress: () => Effect.void,
} as never);

export const MockBankTransactionsRepositoryLayer = Layer.succeed(BankTransactionsRepository, {
  _tag: 'api/BankTransactionsRepository' as const,
  upsertMany: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findByIdAndTeam: () => Effect.succeed(Option.none()),
  listByTeam: () => Effect.succeed([]),
  findDuplicateCandidate: () => Effect.succeed(Option.none()),
  findUnmatchedForTeam: () => Effect.succeed([]),
  updateMatchEvidence: die('MockBankTransactionsRepository.updateMatchEvidence not implemented'),
  ignore: die('MockBankTransactionsRepository.ignore not implemented'),
  bulkIgnore: die('MockBankTransactionsRepository.bulkIgnore not implemented'),
  suppressAutoMatch: die('MockBankTransactionsRepository.suppressAutoMatch not implemented'),
  clearAutoMatchSuppression: die(
    'MockBankTransactionsRepository.clearAutoMatchSuppression not implemented',
  ),
  summaryForTeam: die('MockBankTransactionsRepository.summaryForTeam not implemented'),
} as never);

export const MockBankSyncLayers = Layer.mergeAll(
  MockBankSyncConfigRepositoryLayer,
  MockBankTransactionsRepositoryLayer,
  // Real layer, not a mock — mirrors `emailMocks.ts`'s `EmailSecretCrypto.Default`. Its `make`
  // reads `env.FIO_TOKEN_ENCRYPTION_KEY` lazily at use time ("fails on use, not on boot", D2), and
  // none of the ~40 `ApiLive`-composing test files this is wired into call `encrypt`/`decrypt`.
  FioSecretCrypto.Default,
);

/**
 * `api/bank-sync.ts`'s handler group binds `SqlClient.SqlClient` directly (raw SQL for the
 * transaction queue, exports, manual match/unmatch, VS suggestion — none of which have a
 * repository abstraction), so `ApiLive` as a whole now structurally requires it even for test
 * files whose repositories are all mocked and never touch a real database. A handful of test
 * files (`Roster.test.ts`, `EventRsvp.test.ts`, ...) already define their own local
 * `SqlClient.SqlClient` stub for an unrelated handler (e.g. `roster.ts`'s `deactivateMember`) —
 * this export is named distinctly (`MockGenericSqlClientLayer`, not `MockSqlClientLayer`) so
 * importing it never collides with those, and it is intentionally as inert as the local stubs
 * already in this suite (`(..._args) => Effect.succeed([])`, `withTransaction` a passthrough) —
 * no `bank-sync.ts` endpoint is under test in any of the ~40 files this is wired into.
 */
const genericSqlStub: unknown = Object.assign(
  (..._args: ReadonlyArray<unknown>) => Effect.succeed([]),
  { withTransaction: (effect: unknown) => effect },
);
export const MockGenericSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  genericSqlStub as never,
);
