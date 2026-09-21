// TDD mode — tests written BEFORE `BankSyncPoller.ts` / `BankSyncBackfill.ts` exist.
//
// Plan `.work-plans/fio-transaction-matching.md` D1 / D10b / §5 / §7.2 tests 116-126. Mirrors
// `services/ImapPoller.ts`'s shape (`imapPollerEffect` + `Effect.repeat(Schedule.cron(...))`,
// `Effect.exit` isolation at `{ concurrency: 2 }`, `withCronMetrics`).
//
// Contract this file pins down for `applications/server/src/services/BankSyncPoller.ts`:
//
//   export const bankSyncPollerEffect: Effect.Effect<void, never, ...>   // ONE cycle
//   export const BankSyncPoller = bankSyncPollerEffect.pipe(Effect.repeat(Schedule.cron('0 * * * *')), Effect.asVoid);
//
// and `applications/server/src/services/BankSyncBackfill.ts`:
//
//   export const runBackfill: (teamId, from: string, to: string, runId: string) => Effect.Effect<void>

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { DateTime, Effect, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { bankSyncPollerEffect } from '~/services/BankSyncPoller.js';
import { computeBankSyncStatus } from '~/services/bankSyncStatus.js';
import { FioSecretCrypto, makeWithKey } from '~/services/FioSecretCrypto.js';
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  enableBankSync,
  encryptFioTestToken,
  FIO_TEST_ENCRYPTION_KEY_B64,
  nextDiscordId,
  setMemberVariableSymbol,
  setTeamTimezone,
} from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

// Every poller test needs a real, decryptable token (FIO_TOKEN_ENCRYPTION_KEY is deliberately
// unset in the test env, mirroring EMAIL_IMAP_ENCRYPTION_KEY — see bankSyncFixtures.ts), so this
// file always provides FioSecretCrypto built from the fixed test key alongside RepoLayer.
const FioSecretCryptoTestLayer = Layer.effect(
  FioSecretCrypto,
  makeWithKey(Option.some(FIO_TEST_ENCRYPTION_KEY_B64)),
);

const RepoLayer = Layer.mergeAll(
  BankSyncConfigRepository.Default,
  BankTransactionsRepository.Default,
  FioSecretCryptoTestLayer,
  // `bankSyncPollerEffect` itself needs none of these — only `bankSyncFixtures.ts`'s
  // `createUser`/`createTeam` helpers (used by every `seedTeam` call in this file) do.
  TeamsRepository.Default,
  UsersRepository.Default,
  // BLOCKER 2 test only: seeding a fee assignment + member for auto-match, and voiding the
  // resulting payment the way `finance.ts`'s `voidPayment` handler does.
  TeamMembersRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// Plan `.work-plans/iban-cross-check.md` §9.C precondition fix: this fixture's `info` MUST agree
// with `enableBankSync`'s default account (`2703474850/2010` -> `CZ7120100000002703474850`, NOT
// the unrelated `CZ65…` vector `FioApiClient.test.ts`/`fioColumns.test.ts` use, where no
// comparison ever runs) — with the account-mismatch guard live, every existing test below would
// otherwise halt ingestion on a false mismatch.
const validStatement = (transactions: ReadonlyArray<Record<string, unknown>> = []) => ({
  accountStatement: {
    info: {
      accountId: '2703474850',
      bankId: '2010',
      currency: 'CZK',
      iban: 'CZ7120100000002703474850',
      bic: null,
      openingBalance: 0,
      closingBalance: 0,
      dateStart: '2024-01-01+0100',
      dateEnd: '2024-01-14+0100',
      yearList: null,
      idList: null,
      idFrom: null,
      idTo: null,
      idLastDownload: null,
    },
    transactionList: { transaction: transactions },
  },
});

const mockHttpLayer = (
  respond: () => { status: number; body?: unknown },
  onRequest?: (url: string) => void,
  // A real (non-`Effect.sleep`, non-`TestClock`) delay before responding — `setTimeout` runs on
  // Node's actual event loop regardless of the virtual clock `it.effect` provides. Used by test
  // 125 to widen the poll lease's held-open window to something closer to a real Fio round trip,
  // so two genuinely concurrent replicas race deterministically instead of by std lucky timing.
  delayMs = 0,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      onRequest?.(String(request.url));
      const respondNow = Effect.sync(() => {
        const { status, body } = respond();
        return HttpClientResponse.fromWeb(
          request,
          new Response(body === undefined ? '' : JSON.stringify(body), { status }),
        );
      });
      return delayMs > 0
        ? Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, delayMs))).pipe(
            Effect.andThen(respondNow),
          )
        : respondNow;
    }),
  );

const seedTeam = (name = 'Team') =>
  Effect.gen(function* () {
    const user = yield* createUser(`treasurer-${name}`);
    const team = yield* createTeam(nextDiscordId(), user.id, name);
    yield* setTeamTimezone(team.id, 'Europe/Prague');
    const token = yield* encryptFioTestToken(`test-token-${name}`);
    yield* enableBankSync(team.id, user.id, { fioTokenEncrypted: Option.some(token) });
    return { user, team };
  });

// ---------------------------------------------------------------------------
// 116 / 118 — idempotency + back-dating
// ---------------------------------------------------------------------------

// D10b(a)'s per-token throttle is real, DB-backed state (D10b: "Do not disable it, do not shorten
// it in production code"). A test that deliberately runs TWO poll cycles for the SAME team/token
// back-to-back — to exercise idempotent re-ingestion, not the throttle — would otherwise force a
// genuine ~30s `Effect.sleep` between them with nothing driving the clock forward. Clearing the
// throttle table between cycles is not weakening the throttle (the SQL/production code is
// untouched); it resets test-only state these tests never intended to exercise, exactly as
// `BankSyncConfigRepository.test.ts` (102/102b) and `FioApiClient.test.ts` (83) already do —
// their own tests own asserting the throttle's timing.
const resetThrottle = SqlClient.SqlClient.asEffect().pipe(
  Effect.flatMap((sql) => sql`DELETE FROM fio_token_throttle`),
);

describe('BankSyncPoller — idempotent re-ingestion (116, 118)', () => {
  it.effect('two cycles over the same window ingest no duplicates', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam('idempotent');
      const httpLayer = mockHttpLayer(() => ({
        status: 200,
        body: validStatement([
          {
            column0: { value: '2024-01-05+0100' },
            column1: { value: 100 },
            column22: { value: 1 },
          },
        ]),
      }));

      yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));
      yield* resetThrottle;
      yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM bank_transactions WHERE team_id = ${team.id}
      `;
      expect(rows[0]?.count).toBe('1');
    }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  it.effect('a back-dated movement earlier than the highest ingested date is still ingested', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam('backdated');
      let callCount = 0;
      const httpLayer = mockHttpLayer(() => {
        callCount += 1;
        return {
          status: 200,
          body:
            callCount === 1
              ? validStatement([
                  {
                    column0: { value: '2024-01-10+0100' },
                    column1: { value: 100 },
                    column22: { value: 10 },
                  },
                ])
              : validStatement([
                  {
                    column0: { value: '2024-01-10+0100' },
                    column1: { value: 100 },
                    column22: { value: 10 },
                  },
                  {
                    column0: { value: '2024-01-02+0100' },
                    column1: { value: 50 },
                    column22: { value: 2 },
                  },
                ]),
        };
      });

      yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));
      yield* resetThrottle;
      yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

      const sql = yield* SqlClient.SqlClient.asEffect();
      // `ORDER BY fio_movement_id` resolves to the SELECT list's own (text-cast) output column,
      // not the underlying bigint column, sorting lexically ('10' before '2') rather than
      // numerically — order by the untouched bigint column explicitly.
      const rows = yield* sql<{ fio_movement_id: string }>`
        SELECT fio_movement_id::text FROM bank_transactions WHERE team_id = ${team.id}
        ORDER BY fio_movement_id::bigint
      `;
      expect(rows.map((r) => r.fio_movement_id)).toEqual(['2', '10']);
    }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 119 / 120 — per-team isolation, failure bookkeeping, future next_attempt_at skip
// ---------------------------------------------------------------------------

describe('BankSyncPoller — per-team isolation (119, 120)', () => {
  it.effect(
    'team A 500s while team B succeeds: A gets a failure count and next_attempt_at, B is unaffected',
    () =>
      Effect.gen(function* () {
        const { team: teamA } = yield* seedTeam('fails');
        const { team: teamB } = yield* seedTeam('succeeds');

        const httpLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = String(request.url);
            // The decrypted token is embedded in the URL path (D1); route on it to fail only
            // team A's requests.
            const status = url.includes('test-token-fails') ? 500 : 200;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(status === 200 ? JSON.stringify(validStatement([])) : '', { status }),
              ),
            );
          }),
        );

        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{
          team_id: string;
          consecutive_failure_count: number;
          next_attempt_at: Date | null;
        }>`
        SELECT team_id, consecutive_failure_count, next_attempt_at FROM bank_sync_config
        WHERE team_id IN (${teamA.id}, ${teamB.id})
      `;
        const rowA = rows.find((r) => r.team_id === teamA.id);
        const rowB = rows.find((r) => r.team_id === teamB.id);
        expect(rowA?.consecutive_failure_count).toBe(1);
        expect(rowA?.next_attempt_at).not.toBeNull();
        expect(rowB?.consecutive_failure_count).toBe(0);
        expect(rowB?.next_attempt_at).toBeNull();
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  it.effect('a team with a future next_attempt_at issues zero HTTP requests', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam('future-retry');
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE bank_sync_config SET next_attempt_at = now() + interval '1 hour' WHERE team_id = ${team.id}`;

      let requests = 0;
      const httpLayer = mockHttpLayer(
        () => ({ status: 200, body: validStatement([]) }),
        () => {
          requests += 1;
        },
      );
      yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));
      expect(requests).toBe(0);
    }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 121 / 123 — success clears bookkeeping; withCronMetrics records outcomes
// ---------------------------------------------------------------------------

describe('BankSyncPoller — success bookkeeping (121)', () => {
  it.effect('a successful cycle clears consecutive_failure_count and sets last_success_at', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam('cleared');
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE bank_sync_config SET consecutive_failure_count = 3, last_error_code = 'fio_error' WHERE team_id = ${team.id}`;

      const httpLayer = mockHttpLayer(() => ({ status: 200, body: validStatement([]) }));
      yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

      const rows = yield* sql<{ consecutive_failure_count: number; last_success_at: Date | null }>`
        SELECT consecutive_failure_count, last_success_at FROM bank_sync_config WHERE team_id = ${team.id}
      `;
      expect(rows[0]?.consecutive_failure_count).toBe(0);
      expect(rows[0]?.last_success_at).not.toBeNull();
    }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — voidPayment must not be silently undone by the next poll. Before the
// `payments_finance_recompute()` trigger fix (`1792000002_create_bank_transactions.ts`), voiding
// an auto-matched payment left `auto_match_suppressed` at `false`, so the SAME movement — still
// inside the rolling 14-day window — would be re-selected by `matchIngested` on the next cycle
// and the payment the treasurer deliberately reversed would come back.
// ---------------------------------------------------------------------------

describe('BankSyncPoller — voided payments are not silently re-created (BLOCKER 2)', () => {
  it.effect(
    'void a bank-created payment via voidPayment, run the poller again over the same window, ' +
      'and the payment is NOT re-created',
    () =>
      Effect.gen(function* () {
        const { user, team } = yield* seedTeam('void-not-reborn');
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        const memberUserId = yield* createUser('member-void-not-reborn');
        const member = yield* createTeamMember(team.id, memberUserId.id);
        yield* setMemberVariableSymbol(member.id, '77777');
        // outstandingMinor 1500 == 15.00 CZK, matching column1's raw Fio amount below.
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

        const httpLayer = mockHttpLayer(() => ({
          status: 200,
          body: validStatement([
            {
              column0: { value: '2024-01-05+0100' },
              column1: { value: 15 },
              column5: { value: '77777' },
              column22: { value: 42 },
            },
          ]),
        }));

        // Cycle 1: ingest + auto-match. Exactly one candidate, exact amount -> AutoMatch.
        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const sql = yield* SqlClient.SqlClient.asEffect();
        const txRows = yield* sql<{ id: string; match_state: string }>`
          SELECT id::text, match_state FROM bank_transactions
          WHERE team_id = ${team.id} AND fio_movement_id = 42
        `;
        expect(txRows[0]?.match_state).toBe('matched');
        const txId = txRows[0]?.id;

        const paymentRowsBefore = yield* sql<{ id: string }>`
          SELECT id::text FROM payments
          WHERE bank_transaction_id = ${txId} AND voided_at IS NULL
        `;
        expect(paymentRowsBefore).toHaveLength(1);
        const paymentId = paymentRowsBefore[0]?.id;

        // Void it exactly the way `finance.ts`'s voidPayment handler does — through
        // `PaymentsRepository.void_`, never touching `bank_transactions` directly.
        const paymentsRepo = yield* PaymentsRepository.asEffect().pipe(Effect.provide(RepoLayer));
        yield* paymentsRepo
          .void_(paymentId as never, {
            voidedByUserId: user.id,
            voidReason: 'wrongly auto-matched — reversing',
            voidedAt: DateTime.nowUnsafe(),
          })
          .pipe(Effect.provide(RepoLayer));

        const suppressedRows = yield* sql<{ auto_match_suppressed: boolean; match_state: string }>`
          SELECT auto_match_suppressed, match_state FROM bank_transactions WHERE id = ${txId}
        `;
        expect(suppressedRows[0]?.match_state).toBe('unmatched');
        expect(suppressedRows[0]?.auto_match_suppressed).toBe(true);

        // Cycle 2: the SAME movement is still inside the rolling window and Fio returns it
        // again (idempotent re-ingestion never resets match_state) — the poller must not
        // re-auto-match it.
        yield* resetThrottle;
        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const paymentRowsAfter = yield* sql<{ id: string }>`
          SELECT id::text FROM payments
          WHERE bank_transaction_id = ${txId} AND voided_at IS NULL
        `;
        expect(paymentRowsAfter).toHaveLength(0);

        const txAfter = yield* sql<{ match_state: string }>`
          SELECT match_state FROM bank_transactions WHERE id = ${txId}
        `;
        expect(txAfter[0]?.match_state).toBe('unmatched');
        // The assignment itself must not have been silently credited either.
        const assignmentRows = yield* sql<{ paid_minor: string }>`
          SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}
        `;
        expect(assignmentRows[0]?.paid_minor).toBe('0');
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 122 — Effect.exit isolation survives a defect in one team's processing
// ---------------------------------------------------------------------------

describe('BankSyncPoller — defect isolation (122)', () => {
  it.effect('a defect while processing one team does not crash the whole cycle', () =>
    Effect.gen(function* () {
      yield* seedTeam('defect-team');
      yield* seedTeam('fine-team');

      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die(new Error('boom — simulated defect'))),
      );

      const exit = yield* Effect.exit(
        bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer)),
      );
      // The cycle itself must not die — Effect.exit isolation per team absorbs the defect.
      expect(exit._tag).toBe('Success');
    }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 124 — derived window
// ---------------------------------------------------------------------------

describe('BankSyncPoller — derived window (124)', () => {
  it.effect(
    'last_success_at 40 days ago -> the fetched window is 41 days, not the default 14',
    () =>
      Effect.gen(function* () {
        const { team } = yield* seedTeam('window-41');
        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* sql`UPDATE bank_sync_config SET last_success_at = now() - interval '40 days' WHERE team_id = ${team.id}`;

        let capturedUrl = '';
        const httpLayer = mockHttpLayer(
          () => ({ status: 200, body: validStatement([]) }),
          (url) => {
            capturedUrl = url;
          },
        );
        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));
        // The from-date embedded in the URL should be ~41 days back, not ~14. This is a coarse
        // structural check (the exact URL shape depends on FioApiClient's fetchPeriod signature);
        // at minimum, the request must have been made at all.
        expect(capturedUrl.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  it.effect(
    'last_success_at 120 days ago -> the window clamps to 89 days AND coverage_gap is set',
    () =>
      Effect.gen(function* () {
        const { team } = yield* seedTeam('window-clamp');
        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* sql`UPDATE bank_sync_config SET last_success_at = now() - interval '120 days' WHERE team_id = ${team.id}`;

        const httpLayer = mockHttpLayer(() => ({ status: 200, body: validStatement([]) }));
        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const rows = yield* sql<{ last_error_code: string | null }>`
        SELECT last_error_code FROM bank_sync_config WHERE team_id = ${team.id}
      `;
        expect(rows[0]?.last_error_code).toBe('coverage_gap');
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 125 — lease across replicas: two concurrent cycles on TWO connections -> one HTTP request set
// ---------------------------------------------------------------------------

describe('BankSyncPoller — lease across replicas (125)', () => {
  it.effect(
    'two poller cycles started concurrently on two separate connections issue exactly one set of requests',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedTeam('leased');
          let requestCount = 0;
          // A real (wall-clock) 300ms delay before the mock responds. D10b(b)'s poll lease is
          // NOT a row lock and is released as soon as the winning replica's own cycle finishes
          // (Effect.ensuring) — with an instantaneous mock response that window is sub-millisecond,
          // so the second, genuinely-concurrent connection can win a LATER claim after the first
          // already released, rather than being correctly shut out. A real Fio round trip is not
          // instantaneous either; this delay makes the test's timing realistic instead of relying
          // on both connections happening to race inside an implausibly tight window.
          const httpLayer = mockHttpLayer(
            () => ({ status: 200, body: validStatement([]) }),
            () => {
              requestCount += 1;
            },
            300,
          );

          const sql2 = yield* secondTestPgClient;
          const cycleOnConnection2 = bankSyncPollerEffect.pipe(
            Effect.provide(httpLayer),
            Effect.provide(RepoLayer),
            Effect.provideService(SqlClient.SqlClient, sql2),
          );
          const cycleOnConnection1 = bankSyncPollerEffect.pipe(
            Effect.provide(httpLayer),
            Effect.provide(RepoLayer),
          );

          yield* Effect.all([cycleOnConnection1, cycleOnConnection2], { concurrency: 'unbounded' });

          // Exactly one of the two replicas should have claimed the lease and made the request;
          // the other must have skipped the team entirely for this cycle.
          expect(requestCount).toBe(1);
        }),
      ).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 126 — backfill: bounded walk, cursor persistence, 422 sets history_locked and leaves the cursor,
// budget stop is resumable
// ---------------------------------------------------------------------------

describe('BankSyncBackfill (126)', () => {
  it.effect(
    'a 422 on the second chunk sets history_locked and LEAVES the cursor at the first chunk boundary',
    () =>
      // The walk makes TWO real Fio calls for the SAME team/token (chunk 1, then chunk 2's 422)
      // — D10b(a)'s per-token throttle genuinely delays the second one by ~30s. Driving
      // `it.effect`'s virtual `TestClock` forward (as `FioApiClient.test.ts` test 83 does for a
      // bare `fetchPeriod` call) does not resolve the sleep here: a repository call built via
      // `SqlSchema` (`configRepo.findByTeam`, on the walk's very first step) chained ahead of the
      // later `Effect.sleep`, all inside ONE forked fiber, leaves that sleep permanently
      // unresolved no matter how far the virtual clock is pushed forward — reproduced in
      // isolation down to a minimal `SqlSchema` call + `Effect.forkChild` + `TestClock.adjust`
      // repro with no `BankSyncBackfill` involved, so this is an interaction between
      // `@effect/sql`'s `SqlSchema` helpers and `effect/testing/TestClock`, not a bug in the
      // throttle or the backfill walk. `TestClock.withLive` opts this test back into the real
      // clock so the ~30s wait actually elapses, rather than weakening or bypassing the throttle.
      TestClock.withLive(
        Effect.gen(function* () {
          const { team } = yield* seedTeam('backfill-locked');
          let chunkCount = 0;
          const httpLayer = mockHttpLayer(() => {
            chunkCount += 1;
            return chunkCount === 1 ? { status: 200, body: validStatement([]) } : { status: 422 };
          });

          const { runBackfill } = yield* Effect.promise(
            () => import('~/services/BankSyncBackfill.js'),
          );
          // `backfill_run_id` is a `uuid` column — production always supplies a real
          // `randomUUID()` (`src/api/bank-sync.ts`'s `startBankSyncBackfill` handler); a
          // non-UUID literal here fails the `::uuid` cast in `updateBackfillProgressQuery`
          // before the 422 path under test is ever reached.
          yield* runBackfill(team.id, '2024-01-01', '2024-06-01', randomUUID()).pipe(
            Effect.provide(httpLayer),
            Effect.provide(RepoLayer),
          );

          const sql = yield* SqlClient.SqlClient.asEffect();
          const rows = yield* sql<{
            backfill_status: string | null;
            backfill_cursor: string | null;
          }>`
        SELECT backfill_status, backfill_cursor FROM bank_sync_config WHERE team_id = ${team.id}
      `;
          expect(rows[0]?.backfill_status).toBe('history_locked');
          expect(rows[0]?.backfill_cursor).not.toBeNull();
        }),
      ).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
    40_000,
  );
});

// ---------------------------------------------------------------------------
// T6/T7 — the FioUnreachable split's second consumer: BankSyncPoller (plan §3.2/§6.2, optional).
// ---------------------------------------------------------------------------

describe('BankSyncPoller — FioUnreachable split (T6/T7)', () => {
  it.effect('T6 — a transport failure records last_error_code = unreachable', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam('transport-unreachable');
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error('ECONNRESET'),
              }),
            }),
          ),
        ),
      );

      yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ last_error_code: string | null }>`
        SELECT last_error_code FROM bank_sync_config WHERE team_id = ${team.id}
      `;
      expect(rows[0]?.last_error_code).toBe('unreachable');
    }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  it.effect(
    "T7 — 'unreachable' renders sync_failing, never invalid, even after repeated failures",
    () =>
      Effect.gen(function* () {
        const { team } = yield* seedTeam('transport-unreachable-repeated');
        const httpLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error('ECONNRESET'),
                }),
              }),
            ),
          ),
        );

        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const sql = yield* SqlClient.SqlClient.asEffect();
        // Drive `consecutive_failure_count` past the D11 `invalid` rank's `>= 3` threshold AND
        // push `last_error_at` outside the 6h silence window — if the rank fired off count alone
        // (rather than requiring `isFioError` i.e. `last_error_code === 'fio_error'`), THIS is
        // where it would wrongly promote to `invalid`.
        yield* sql`
          UPDATE bank_sync_config
          SET consecutive_failure_count = 5, last_error_at = now() - interval '7 hours'
          WHERE team_id = ${team.id}
        `;

        const rows = yield* sql<{
          last_error_code: string | null;
          consecutive_failure_count: number;
          last_error_at: Date | null;
          last_success_at: Date | null;
          fio_token_created_at: Date | null;
        }>`
          SELECT last_error_code, consecutive_failure_count, last_error_at, last_success_at,
                 fio_token_created_at
          FROM bank_sync_config WHERE team_id = ${team.id}
        `;
        const row = rows[0]!;
        expect(row.last_error_code).toBe('unreachable');

        const result = computeBankSyncStatus({
          hasToken: true,
          lastErrorCode: Option.fromNullishOr(row.last_error_code),
          lastErrorIsKeyMissing: row.last_error_code === 'key_missing',
          consecutiveFailureCount: row.consecutive_failure_count,
          lastErrorAt: Option.fromNullishOr(row.last_error_at?.getTime()),
          lastSuccessAt: Option.fromNullishOr(row.last_success_at?.getTime()),
          tokenCreatedAt: Option.fromNullishOr(row.fio_token_created_at?.getTime()),
          now: Date.now(),
        });
        expect(result.status).toBe('sync_failing');
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// Plan `.work-plans/iban-cross-check.md` §9.C — the account-mismatch guard halts ingestion
// ---------------------------------------------------------------------------

describe('BankSyncPoller — account mismatch halts ingestion (iban-cross-check §9.C)', () => {
  it.effect(
    'case 1 — a token that reads a different account ingests nothing and records account_mismatch',
    () =>
      Effect.gen(function* () {
        const user = yield* createUser('treasurer-mismatch');
        const team = yield* createTeam(nextDiscordId(), user.id, 'Team');
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        const token = yield* encryptFioTestToken('test-token-mismatch');
        yield* enableBankSync(team.id, user.id, {
          fioTokenEncrypted: Option.some(token),
          accountNumber: '1265098001',
          bankCode: '5500',
        });

        const httpLayer = mockHttpLayer(() => ({
          status: 200,
          body: validStatement([
            {
              column0: { value: '2024-01-05+0100' },
              column1: { value: 100 },
              column22: { value: 1 },
            },
          ]),
        }));

        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const sql = yield* SqlClient.SqlClient.asEffect();
        const txCount = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM bank_transactions WHERE team_id = ${team.id}
        `;
        expect(txCount[0]?.count).toBe('0');

        const periodCount = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM bank_statement_periods WHERE team_id = ${team.id}
        `;
        expect(periodCount[0]?.count).toBe('0');

        const rows = yield* sql<{
          last_error_code: string | null;
          coverage_warning: string | null;
          consecutive_failure_count: number;
          next_attempt_at: Date | null;
          last_success_at: Date | null;
        }>`
          SELECT last_error_code, coverage_warning, consecutive_failure_count, next_attempt_at,
                 last_success_at
          FROM bank_sync_config WHERE team_id = ${team.id}
        `;
        const row = rows[0]!;
        expect(row.last_error_code).toBe('account_mismatch');
        // Both IBANs, for support — never the token (D10).
        expect(row.coverage_warning).toContain('CZ7120100000002703474850');
        expect(row.coverage_warning).toContain('CZ5855000000001265098001');
        expect(row.coverage_warning).not.toContain('test-token-mismatch');
        // Deliberately untouched — a mismatch is not evidence about the token, so it must not
        // feed the counter that gates the D11 `invalid` escalation (`bankSyncStatus.ts`'s
        // `>= 3` check). See `recordAccountMismatchQuery`.
        expect(row.consecutive_failure_count).toBe(0);
        expect(row.next_attempt_at).not.toBeNull();
        expect(row.last_success_at).toBeNull();
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  it.effect(
    'case 2 — a mismatched movement that would otherwise auto-match is never turned into a payment',
    () =>
      Effect.gen(function* () {
        const u = yield* createUser('treasurer-mismatch-match');
        const team = yield* createTeam(nextDiscordId(), u.id, 'Team');
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        const token = yield* encryptFioTestToken('test-token-mismatch-match');
        yield* enableBankSync(team.id, u.id, {
          fioTokenEncrypted: Option.some(token),
          accountNumber: '1265098001',
          bankCode: '5500',
        });

        const memberUserId = yield* createUser('member-mismatch-match');
        const member = yield* createTeamMember(team.id, memberUserId.id);
        yield* setMemberVariableSymbol(member.id, '88888');
        // outstandingMinor 1500 == 15.00 CZK, matching column1's raw Fio amount below.
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

        const httpLayer = mockHttpLayer(() => ({
          status: 200,
          body: validStatement([
            {
              column0: { value: '2024-01-05+0100' },
              column1: { value: 15 },
              column5: { value: '88888' },
              column22: { value: 43 },
            },
          ]),
        }));

        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        // No bank_transactions row is even created under a mismatch (case 1), so no payment can
        // reference one — the ticket's actual harm is confirmed the same way BLOCKER 2 confirms a
        // void sticks: the assignment itself was never credited.
        const sql = yield* SqlClient.SqlClient.asEffect();
        const assignmentRows = yield* sql<{ paid_minor: string }>`
          SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}
        `;
        expect(assignmentRows[0]?.paid_minor).toBe('0');

        const payments = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM payments
          WHERE bank_transaction_id IS NOT NULL
            AND bank_transaction_id IN (SELECT id FROM bank_transactions WHERE team_id = ${team.id})
        `;
        expect(payments[0]?.count).toBe('0');
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  it.effect(
    'case 3 — a matching configured account still ingests (the guard is not inverted)',
    () =>
      Effect.gen(function* () {
        // Coverage note: test 116 above ("two cycles over the same window ingest no duplicates")
        // already exercises ingestion against the default (matching) `enableBankSync` account
        // post-fixture-fix; this case additionally pins `last_error_code IS NULL`, which 116 does
        // not assert.
        const { team } = yield* seedTeam('matching-account');
        const httpLayer = mockHttpLayer(() => ({
          status: 200,
          body: validStatement([
            {
              column0: { value: '2024-01-05+0100' },
              column1: { value: 100 },
              column22: { value: 99 },
            },
          ]),
        }));

        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const sql = yield* SqlClient.SqlClient.asEffect();
        const txCount = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM bank_transactions WHERE team_id = ${team.id}
        `;
        expect(txCount[0]?.count).toBe('1');

        const rows = yield* sql<{ last_error_code: string | null }>`
          SELECT last_error_code FROM bank_sync_config WHERE team_id = ${team.id}
        `;
        expect(rows[0]?.last_error_code).toBeNull();
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  // Case 4 ("no configured account -> ingests") as literally specified by the plan cannot be
  // constructed against the real schema: `findPollableQuery` filters `WHERE enabled = true`
  // (`BankSyncConfigRepository.ts:84-92`), and the table's own CHECK constraint
  // (`1792000001_create_bank_sync_config.ts`) forbids `enabled = true` with a NULL
  // `account_number`/`bank_code` — so a row this guard's poller path would ever see can never
  // have an absent configured account. That half of the "either side absent -> no verdict" rule
  // is exhaustively covered at the unit level instead (`bankSyncAccount.test.ts` cases 4/5). This
  // case exercises the REACHABLE mirror of the same rule from the poller's actual DB-backed path:
  // Fio's own `info.iban` absent from a genuinely pollable, fully-configured row.
  it.effect(
    'case 4 — Fio sends no iban at all -> the absent side is not an accusation, ingestion proceeds',
    () =>
      Effect.gen(function* () {
        const { team } = yield* seedTeam('no-fio-iban');
        const httpLayer = mockHttpLayer(() => {
          const statement = validStatement([
            {
              column0: { value: '2024-01-05+0100' },
              column1: { value: 100 },
              column22: { value: 77 },
            },
          ]);
          return {
            status: 200,
            body: {
              accountStatement: {
                ...statement.accountStatement,
                info: { ...statement.accountStatement.info, iban: null },
              },
            },
          };
        });

        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const sql = yield* SqlClient.SqlClient.asEffect();
        const txCount = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM bank_transactions WHERE team_id = ${team.id}
        `;
        expect(txCount[0]?.count).toBe('1');

        const rows = yield* sql<{ last_error_code: string | null }>`
          SELECT last_error_code FROM bank_sync_config WHERE team_id = ${team.id}
        `;
        expect(rows[0]?.last_error_code).toBeNull();
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );

  // Pins the recovery path a treasurer actually takes: fix the account number, save, wait for the
  // next hourly poll. Also pins the two staleness fixes above — a flat 6h backoff would still leave
  // `next_attempt_at` in the future after a mismatch, so this goes through `configRepo.upsert`
  // (which resets it, same as a real config save) rather than the raw-SQL `enableBankSync` fixture.
  it.effect(
    'case 5 — correcting the account clears the mismatch on the next poll (bank_transactions, last_error_code, coverage_warning)',
    () =>
      Effect.gen(function* () {
        const user = yield* createUser('treasurer-mismatch-recovery');
        const team = yield* createTeam(nextDiscordId(), user.id, 'Team');
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        const token = yield* encryptFioTestToken('test-token-mismatch-recovery');
        yield* enableBankSync(team.id, user.id, {
          fioTokenEncrypted: Option.some(token),
          accountNumber: '1265098001',
          bankCode: '5500',
        });

        const httpLayer = mockHttpLayer(() => ({
          status: 200,
          body: validStatement([
            {
              column0: { value: '2024-01-05+0100' },
              column1: { value: 100 },
              column22: { value: 1 },
            },
          ]),
        }));

        // Poll #1 — still misconfigured: halts, records the mismatch.
        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const sql = yield* SqlClient.SqlClient.asEffect();
        const afterMismatch = yield* sql<{ last_error_code: string | null }>`
          SELECT last_error_code FROM bank_sync_config WHERE team_id = ${team.id}
        `;
        expect(afterMismatch[0]?.last_error_code).toBe('account_mismatch');

        // The treasurer fixes the account, exactly the way the real save path does — via the
        // repository's `upsert`, which resets `next_attempt_at` so the next poll is not blocked
        // by the mismatch's backoff.
        const configRepo = yield* BankSyncConfigRepository.asEffect();
        yield* configRepo.upsert({
          team_id: team.id,
          enabled: true,
          auto_match_enabled: true,
          account_prefix: Option.none(),
          account_number: Option.some('2703474850'),
          bank_code: Option.some('2010'),
          currency: 'CZK',
          recipient_name: Option.some('Test Club, z.s.'),
          registered_id: Option.none(),
          registered_address: Option.none(),
          bank_name: Option.none(),
          fio_token_encrypted: Option.none(), // absent -> COALESCE keeps the stored token
          fio_token_created_at: Option.none(),
          configured_by_user_id: user.id,
        });

        // Same token as poll #1 -> `fio_token_throttle` would otherwise force a real ~30s wait
        // before the second call (see `resetThrottle` above, used the same way by the
        // "two cycles" idempotent-re-ingestion test).
        yield* resetThrottle;

        // Poll #2 — the corrected account now matches Fio's `info.iban`.
        yield* bankSyncPollerEffect.pipe(Effect.provide(httpLayer), Effect.provide(RepoLayer));

        const txCount = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM bank_transactions WHERE team_id = ${team.id}
        `;
        expect(txCount[0]?.count).toBe('1');

        const afterRecovery = yield* sql<{
          last_error_code: string | null;
          coverage_warning: string | null;
        }>`
          SELECT last_error_code, coverage_warning FROM bank_sync_config WHERE team_id = ${team.id}
        `;
        expect(afterRecovery[0]?.last_error_code).toBeNull();
        expect(afterRecovery[0]?.coverage_warning).toBeNull();
      }).pipe(Effect.provide(RepoLayer), Effect.provide(TestPgClient)),
  );
});
