// TDD mode — tests written BEFORE `BankTransactionMatcher.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` §4 / §7.2 tests 127-145. Seeded-DB tests against
// the REAL `fee_assignment_status_v` view and the REAL `payments_finance_recompute` trigger.
//
// Contract this file pins down for
// `applications/server/src/services/BankTransactionMatcher.ts`:
//
//   export interface MatchOutcome {
//     readonly _tag: 'AutoMatched' | 'Queued';
//     readonly matchReason?: BankTransaction.BankTransactionMatchReason;
//   }
//   export interface BankTransactionMatcherOptions {
//     /** Test-only seam (plan §7.2 test 139/140): runs right after candidate assignments are
//      * read and BEFORE the locking transaction begins. Defaults to `Effect.void`. */
//     readonly afterCandidateRead?: Effect.Effect<void>;
//   }
//   export const make: (options?: BankTransactionMatcherOptions) =>
//     Effect.Effect<{ matchOne: (txId: BankTransaction.BankTransactionId) => Effect.Effect<MatchOutcome> },
//                    never, SqlClient.SqlClient | PaymentsRepository | ...>
//   export class BankTransactionMatcher extends ServiceMap.Service<...>()('api/BankTransactionMatcher') {
//     static readonly Default = Layer.effect(BankTransactionMatcher, make());
//   }
//
// Step 4's SQL lock order (§4, D10c): `bank_transactions` row FIRST, then every candidate
// `fee_assignments` row `ORDER BY id FOR UPDATE`. `matchOne` re-validates the decision under lock
// and queues (never writes) if the world changed since the candidate read.

import { describe, expect, it } from '@effect/vitest';
import { DateTime, Deferred, Effect, Fiber, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { BankTransactionMatcher, make as makeMatcher } from '~/services/BankTransactionMatcher.js';
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  enableBankSync,
  insertBankTransaction,
  nextDiscordId,
  setMemberVariableSymbol,
  setTeamTimezone,
} from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const RepoLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
);

const TestLayer = Layer.mergeAll(RepoLayer, BankTransactionMatcher.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Fixture: one team, one member with a VS, one fee assignment, bank sync enabled
// ---------------------------------------------------------------------------

const seedTeamAndMember = (vs = '12345', outstandingMinor = 1500) =>
  Effect.gen(function* () {
    const user = yield* createUser('treasurer');
    const team = yield* createTeam(nextDiscordId(), user.id);
    yield* setTeamTimezone(team.id, 'Europe/Prague');
    yield* enableBankSync(team.id, user.id);
    const memberUser = yield* createUser('player-1');
    const member = yield* createTeamMember(team.id, memberUser.id);
    yield* setMemberVariableSymbol(member.id, vs);
    const { fee, assignment } = yield* createFeeAndAssignment(team.id, member.id, outstandingMinor);
    return { user, team, memberUser, member, fee, assignment };
  });

const paidMinorFor = (assignmentId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          paid_minor: string;
        }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignmentId}`,
    ),
    Effect.map((rows) => Number(rows[0]?.paid_minor ?? -1)),
  );

const matchStateFor = (txId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ match_state: string; match_reason: string | null }>`
        SELECT match_state, match_reason FROM bank_transactions WHERE id = ${txId}
      `,
    ),
    Effect.map((rows) => rows[0]),
  );

// ---------------------------------------------------------------------------
// 127-134 — one case per decision-table row, against the REAL view/triggers
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — decision table against real data (127-134)', () => {
  it.effect('case A — single exact candidate auto-matches, paid_minor updates via trigger', () =>
    Effect.gen(function* () {
      const { team, assignment } = yield* seedTeamAndMember('12345', 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 1,
        bookedOn: '2024-03-01',
        amountMinor: 1500,
        variableSymbol: '12345',
      });
      const outcome = yield* matcher.matchOne(txId as never);
      expect(outcome._tag).toBe('AutoMatched');
      expect(yield* paidMinorFor(assignment.id)).toBe(1500);
      const state = yield* matchStateFor(txId as never);
      expect(state?.match_state).toBe('matched');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'case D — underpayment queues amount_mismatch_under, paid_minor stays 0 (42, 136)',
    () =>
      Effect.gen(function* () {
        const { team, assignment } = yield* seedTeamAndMember('12345', 1500);
        const matcher = yield* BankTransactionMatcher.asEffect();
        const txId = yield* insertBankTransaction(team.id, {
          fioMovementId: 2,
          bookedOn: '2024-03-01',
          amountMinor: 300,
          variableSymbol: '12345',
        });
        const outcome = yield* matcher.matchOne(txId as never);
        expect(outcome._tag).toBe('Queued');
        if (outcome._tag === 'Queued') expect(outcome.matchReason).toBe('amount_mismatch_under');
        expect(yield* paidMinorFor(assignment.id)).toBe(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('case E — overpayment queues overpayment', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeamAndMember('12345', 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 3,
        bookedOn: '2024-03-01',
        amountMinor: 2000,
        variableSymbol: '12345',
      });
      const outcome = yield* matcher.matchOne(txId as never);
      expect(outcome._tag).toBe('Queued');
      if (outcome._tag === 'Queued') expect(outcome.matchReason).toBe('overpayment');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('case G — zero open assignments queues no_open_assignment', () =>
    Effect.gen(function* () {
      // A member with a VS but NO fee assignment at all — case G, distinct from case H (no
      // member for the VS): here the member resolves fine, there is simply nothing open to pay.
      const user = yield* createUser('treasurer-caseg');
      const team = yield* createTeam(nextDiscordId(), user.id);
      yield* setTeamTimezone(team.id, 'Europe/Prague');
      yield* enableBankSync(team.id, user.id);
      const matcher = yield* BankTransactionMatcher.asEffect();

      const secondVs = '99999';
      const member2User = yield* createUser('player-no-fee');
      const member2 = yield* createTeamMember(team.id, member2User.id);
      yield* setMemberVariableSymbol(member2.id, secondVs);

      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 4,
        bookedOn: '2024-03-01',
        amountMinor: 500,
        variableSymbol: secondVs,
      });
      const outcome = yield* matcher.matchOne(txId as never);
      expect(outcome._tag).toBe('Queued');
      if (outcome._tag === 'Queued') expect(outcome.matchReason).toBe('no_open_assignment');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('case H — VS matches no member queues no_member_for_vs', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeamAndMember('12345', 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 5,
        bookedOn: '2024-03-01',
        amountMinor: 500,
        // '00000' would normalise to NULL under D3's NULLIF(ltrim(vs,'0'),'') and land on
        // no_vs instead of the no_member_for_vs this case intends to exercise — '99999'
        // survives normalisation and matches no member.
        variableSymbol: '99999',
      });
      const outcome = yield* matcher.matchOne(txId as never);
      expect(outcome._tag).toBe('Queued');
      if (outcome._tag === 'Queued') expect(outcome.matchReason).toBe('no_member_for_vs');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('no VS at all queues no_vs', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeamAndMember('12345', 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 6,
        bookedOn: '2024-03-01',
        amountMinor: 500,
        variableSymbol: null,
      });
      const outcome = yield* matcher.matchOne(txId as never);
      expect(outcome._tag).toBe('Queued');
      if (outcome._tag === 'Queued') expect(outcome.matchReason).toBe('no_vs');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 135 — case A never issues an UPDATE against paid_minor directly
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — paid_minor is trigger-owned (135)', () => {
  it.effect('case A: paid_minor is correct and the assignment status is "paid" via the view', () =>
    Effect.gen(function* () {
      const { team, assignment } = yield* seedTeamAndMember('12345', 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 7,
        bookedOn: '2024-03-01',
        amountMinor: 1500,
        variableSymbol: '12345',
      });
      yield* matcher.matchOne(txId as never);

      const sql = yield* SqlClient.SqlClient.asEffect();
      const view = yield* sql<{ status: string }>`
        SELECT status FROM fee_assignment_status_v WHERE assignment_id = ${assignment.id}
      `;
      expect(view[0]?.status).toBe('paid');
      // NOTE: "no UPDATE was issued against paid_minor" is a code-review-level invariant (the
      // matcher's write set is `match_evidence`/`match_reason` on `bank_transactions` plus an
      // INSERT into `payments` — never a direct UPDATE of `fee_assignments.paid_minor`, which the
      // pre-existing trigger owns exclusively). This test pins the OBSERVABLE consequence: the
      // value is correct without the matcher ever seeing `fee_assignments` in its own write set.
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 137 — duplicate pre-check
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — duplicate pre-check (137)', () => {
  it.effect(
    'a second identical transfer against a now-closed assignment queues as no_open_assignment with a duplicate hint, paid_minor does not double',
    () =>
      Effect.gen(function* () {
        const { team, assignment } = yield* seedTeamAndMember('12345', 1500);
        const matcher = yield* BankTransactionMatcher.asEffect();
        const firstTx = yield* insertBankTransaction(team.id, {
          fioMovementId: 8,
          bookedOn: '2024-03-01',
          amountMinor: 1500,
          variableSymbol: '12345',
        });
        yield* matcher.matchOne(firstTx as never);
        expect(yield* paidMinorFor(assignment.id)).toBe(1500);

        const secondTx = yield* insertBankTransaction(team.id, {
          fioMovementId: 9,
          bookedOn: '2024-03-03', // within +-7 days
          amountMinor: 1500,
          variableSymbol: '12345',
        });
        const outcome = yield* matcher.matchOne(secondTx as never);
        expect(outcome._tag).toBe('Queued');
        if (outcome._tag === 'Queued') {
          expect(outcome.matchReason).toBe('no_open_assignment');
          expect(outcome.matchReason).not.toBe('possible_duplicate');
        }
        expect(yield* paidMinorFor(assignment.id)).toBe(1500); // unchanged, not doubled
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 138 — re-entrancy: running the matcher twice over one row creates exactly one payment
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — re-entrancy (138)', () => {
  it.effect(
    'running matchOne twice over the same already-matched row creates exactly one payment',
    () =>
      Effect.gen(function* () {
        const { team, assignment } = yield* seedTeamAndMember('12345', 1500);
        const matcher = yield* BankTransactionMatcher.asEffect();
        const txId = yield* insertBankTransaction(team.id, {
          fioMovementId: 10,
          bookedOn: '2024-03-01',
          amountMinor: 1500,
          variableSymbol: '12345',
        });
        yield* matcher.matchOne(txId as never);
        yield* matcher.matchOne(txId as never); // the row is no longer 'unmatched' — must be a no-op

        const sql = yield* SqlClient.SqlClient.asEffect();
        const payments = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM payments WHERE fee_assignment_id = ${assignment.id}
      `;
        expect(payments[0]?.count).toBe('1');
        expect(yield* paidMinorFor(assignment.id)).toBe(1500);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 139 — THE concurrency test: two matchers on two connections, deterministic via the
// afterCandidateRead + Deferred seam, racing two 1500 transfers against a single 1500 assignment.
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — deterministic concurrency (139, the important one)', () => {
  it.effect(
    'two matchers on two connections racing two identical transfers -> paid_minor == 1500, one auto-match, one queued',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { team, assignment } = yield* seedTeamAndMember('12345', 1500);
          const txA = yield* insertBankTransaction(team.id, {
            fioMovementId: 11,
            bookedOn: '2024-03-01',
            amountMinor: 1500,
            variableSymbol: '12345',
          });
          const txB = yield* insertBankTransaction(team.id, {
            fioMovementId: 12,
            bookedOn: '2024-03-01',
            amountMinor: 1500,
            variableSymbol: '12345',
          });

          const reachedHook = yield* Deferred.make<void>();
          const releaseA = yield* Deferred.make<void>();

          // Matcher A: reads candidates (sees outstanding = 1500), signals it has reached the
          // hook, then BLOCKS until matcher B has fully committed its own match.
          const matcherA = yield* makeMatcher({
            afterCandidateRead: Deferred.succeed(reachedHook, undefined).pipe(
              Effect.asVoid,
              Effect.andThen(Deferred.await(releaseA)),
            ),
          });

          // Matcher B runs on a SECOND, independent connection with no seam — it will complete
          // its match (lock, decide, write) in full before A is released.
          const sql2 = yield* secondTestPgClient;
          const matcherB = yield* makeMatcher().pipe(
            Effect.provideService(SqlClient.SqlClient, sql2),
          );

          const fiberA = yield* Effect.forkChild(matcherA.matchOne(txA as never));
          yield* Deferred.await(reachedHook);

          const outcomeB = yield* matcherB.matchOne(txB as never);
          expect(outcomeB._tag).toBe('AutoMatched');
          expect(yield* paidMinorFor(assignment.id)).toBe(1500);

          yield* Deferred.succeed(releaseA, undefined);
          const outcomeA = yield* Fiber.join(fiberA);

          // A re-validated under lock, found the assignment already fully paid, and queued
          // instead of double-crediting.
          expect(outcomeA._tag).toBe('Queued');
          expect(yield* paidMinorFor(assignment.id)).toBe(1500); // still 1500 — NOT 3000
        }),
      ).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 141 — VS normalisation
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — VS normalisation (141)', () => {
  it.effect(
    'a leading-zero-padded VS "0012345" resolves and auto-matches against a stored "12345"',
    () =>
      Effect.gen(function* () {
        const { team } = yield* seedTeamAndMember('12345', 1500);
        const matcher = yield* BankTransactionMatcher.asEffect();
        const tx = yield* insertBankTransaction(team.id, {
          fioMovementId: 13,
          bookedOn: '2024-03-01',
          amountMinor: 1500,
          variableSymbol: '0012345',
        });
        const outcome = yield* matcher.matchOne(tx as never);
        expect(outcome._tag).toBe('AutoMatched');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'a whitespace-padded VS " 12345 " resolves and auto-matches against a stored "12345"',
    () =>
      Effect.gen(function* () {
        const { team } = yield* seedTeamAndMember('12345', 1500);
        const matcher = yield* BankTransactionMatcher.asEffect();
        const tx = yield* insertBankTransaction(team.id, {
          fioMovementId: 14,
          bookedOn: '2024-03-01',
          amountMinor: 1500,
          variableSymbol: ' 12345 ',
        });
        const outcome = yield* matcher.matchOne(tx as never);
        expect(outcome._tag).toBe('AutoMatched');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 142 — VS recycling guard
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — VS recycling guard (142)', () => {
  it.effect(
    'a transaction booked before (joined_at - 30d) is not credited to the current VS holder',
    () =>
      Effect.gen(function* () {
        const user = yield* createUser('treasurer-vsr');
        const team = yield* createTeam(nextDiscordId(), user.id);
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        yield* enableBankSync(team.id, user.id);
        const memberUser = yield* createUser('player-recycled');
        const joinedAt = DateTime.makeUnsafe('2024-06-01T00:00:00.000Z');
        const member = yield* createTeamMember(team.id, memberUser.id, { joinedAt });
        yield* setMemberVariableSymbol(member.id, '55555');
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

        const matcher = yield* BankTransactionMatcher.asEffect();
        // Booked well before joined_at - 30 days.
        const txId = yield* insertBankTransaction(team.id, {
          fioMovementId: 14,
          bookedOn: '2024-01-01',
          amountMinor: 1500,
          variableSymbol: '55555',
        });
        const outcome = yield* matcher.matchOne(txId as never);
        expect(outcome._tag).toBe('Queued');
        expect(yield* paidMinorFor(assignment.id)).toBe(0);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 143 — auto_match_enabled = false -> everything queues
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — auto_match_enabled = false (143)', () => {
  it.effect(
    'an otherwise-perfect case A candidate still queues when auto-match is disabled for the team',
    () =>
      Effect.gen(function* () {
        const user = yield* createUser('treasurer-disabled');
        const team = yield* createTeam(nextDiscordId(), user.id);
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        yield* enableBankSync(team.id, user.id, { autoMatchEnabled: false });
        const memberUser = yield* createUser('player-disabled');
        const member = yield* createTeamMember(team.id, memberUser.id);
        yield* setMemberVariableSymbol(member.id, '77777');
        yield* createFeeAndAssignment(team.id, member.id, 1500);

        const matcher = yield* BankTransactionMatcher.asEffect();
        const txId = yield* insertBankTransaction(team.id, {
          fioMovementId: 15,
          bookedOn: '2024-03-01',
          amountMinor: 1500,
          variableSymbol: '77777',
        });
        const outcome = yield* matcher.matchOne(txId as never);
        expect(outcome._tag).toBe('Queued');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 144 — the created payment's fields
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — created payment fields (144)', () => {
  it.effect(
    "method='bank_transfer', matched_by='auto', recorded_by_user_id=configured_by_user_id, bank_transaction_id set, note carries the movement id",
    () =>
      Effect.gen(function* () {
        const { team, user, assignment } = yield* seedTeamAndMember('12345', 1500);
        const matcher = yield* BankTransactionMatcher.asEffect();
        const txId = yield* insertBankTransaction(team.id, {
          fioMovementId: 424242,
          bookedOn: '2024-03-01',
          amountMinor: 1500,
          variableSymbol: '12345',
        });
        yield* matcher.matchOne(txId as never);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{
          method: string;
          matched_by: string;
          recorded_by_user_id: string;
          bank_transaction_id: string;
          note: string;
        }>`
        SELECT method, matched_by, recorded_by_user_id, bank_transaction_id, note
        FROM payments WHERE fee_assignment_id = ${assignment.id}
      `;
        expect(rows[0]?.method).toBe('bank_transfer');
        expect(rows[0]?.matched_by).toBe('auto');
        expect(rows[0]?.recorded_by_user_id).toBe(user.id);
        expect(rows[0]?.bank_transaction_id).toBe(txId);
        expect(rows[0]?.note).toContain('424242');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 145 — paid_at is noon team-local (D14), across negative and non-whole-hour zones
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher — paid_at is noon team-local (145, D14)', () => {
  it.effect(
    "America/New_York (negative offset): booked_on '2026-02-01' -> paid_at renders as 2026-02-01 local, not 01-31 or 03-01",
    () =>
      Effect.gen(function* () {
        const user = yield* createUser('treasurer-ny');
        const team = yield* createTeam(nextDiscordId(), user.id);
        yield* setTeamTimezone(team.id, 'America/New_York');
        yield* enableBankSync(team.id, user.id);
        const memberUser = yield* createUser('player-ny');
        const member = yield* createTeamMember(team.id, memberUser.id);
        yield* setMemberVariableSymbol(member.id, '11111');
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

        const matcher = yield* BankTransactionMatcher.asEffect();
        const txId = yield* insertBankTransaction(team.id, {
          fioMovementId: 16,
          bookedOn: '2026-02-01',
          amountMinor: 1500,
          variableSymbol: '11111',
        });
        yield* matcher.matchOne(txId as never);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{ local_date: string }>`
        SELECT to_char(p.paid_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS local_date
        FROM payments p WHERE p.fee_assignment_id = ${assignment.id}
      `;
        expect(rows[0]?.local_date).toBe('2026-02-01');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'Asia/Kathmandu (non-whole-hour +05:45 offset): booked_on renders on the correct local day',
    () =>
      Effect.gen(function* () {
        const user = yield* createUser('treasurer-ktm');
        const team = yield* createTeam(nextDiscordId(), user.id);
        yield* setTeamTimezone(team.id, 'Asia/Kathmandu');
        yield* enableBankSync(team.id, user.id);
        const memberUser = yield* createUser('player-ktm');
        const member = yield* createTeamMember(team.id, memberUser.id);
        yield* setMemberVariableSymbol(member.id, '22222');
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

        const matcher = yield* BankTransactionMatcher.asEffect();
        const txId = yield* insertBankTransaction(team.id, {
          fioMovementId: 17,
          bookedOn: '2026-07-15',
          amountMinor: 1500,
          variableSymbol: '22222',
        });
        yield* matcher.matchOne(txId as never);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{ local_date: string; local_time: string }>`
        SELECT to_char(p.paid_at AT TIME ZONE 'Asia/Kathmandu', 'YYYY-MM-DD') AS local_date,
               to_char(p.paid_at AT TIME ZONE 'Asia/Kathmandu', 'HH24:MI') AS local_time
        FROM payments p WHERE p.fee_assignment_id = ${assignment.id}
      `;
        expect(rows[0]?.local_date).toBe('2026-07-15');
        expect(rows[0]?.local_time).toBe('12:00');
      }).pipe(Effect.provide(TestLayer)),
  );
});
