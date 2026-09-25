// TDD mode — tests written BEFORE `BankSyncConfigRepository.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D10b / §7.2 tests 96-104c. This repository
// mediates the ONLY writes to `bank_sync_config`, `fio_token_throttle` and
// `bank_statement_periods` (D10b: "This reservation lives inside FioApiClient" — but that's the
// CLIENT calling this repository's throttle method; the SQL itself lives here).
//
// Contract this file pins down for
// `applications/server/src/repositories/BankSyncConfigRepository.ts` (return type is the domain
// `BankSyncConfig.BankSyncConfig` model unless noted):
//
//   findByTeam(teamId): Effect<Option<BankSyncConfig>>
//   upsert(input: UpsertBankSyncConfigInput): Effect<BankSyncConfig>
//     — `fio_token_encrypted: Option.none()` means "keep the stored token" (COALESCE, mirroring
//       `EmailForwardingConfigRepository.upsertQuery`'s `imap_secret_encrypted` line); every
//       upsert resets `consecutive_failure_count` to 0 and `next_attempt_at` to NULL and
//       re-points `configured_by_user_id`.
//   findPollable(): Effect<ReadonlyArray<BankSyncConfig>>
//     — enabled=true, fio_token_encrypted IS NOT NULL, next_attempt_at IS NULL OR <= now().
//   claimPollLease(teamId, holder: string, leaseSeconds: number): Effect<Option<BankSyncConfig>>
//   releasePollLease(teamId, holder: string): Effect<void>            — guarded by holder (D10b defect f)
//   claimRematchLease(teamId, holder: string, leaseSeconds: number): Effect<Option<BankSyncConfig>>
//   releaseRematchLease(teamId, holder: string): Effect<void>
//   reserveThrottleSlot(tokenFingerprint: string): Effect<Duration.Duration>
//     — single autocommitted UPSERT statement (D10b defect e(i)/e(ii)); the caller sleeps the
//       returned duration OUTSIDE any transaction.
//   recordSuccess(teamId): Effect<void>
//   recordFailure(teamId, errorCode: string): Effect<void>
//   upsertStatementPeriod(input: { teamId, dateStart, dateEnd, openingBalanceMinor, closingBalanceMinor, currency }): Effect<void>
//   findStatementPeriods(teamId): Effect<ReadonlyArray<{...}>>

import { describe, expect, it } from '@effect/vitest';
import { DateTime, Duration, Effect, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  BankSyncConfigRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const setup = Effect.gen(function* () {
  const user = yield* createUser('treasurer-1');
  const team = yield* createTeam(nextDiscordId(), user.id);
  return { user, team };
});

const fullUpsertInput = (teamId: string, userId: string) => ({
  team_id: teamId,
  enabled: true,
  auto_match_enabled: true,
  auto_credit_enabled: Option.some(true),
  auto_create_expenses: Option.some(true),
  account_prefix: Option.some('19'),
  account_number: Option.some('2000145399'),
  bank_code: Option.some('0800'),
  currency: 'CZK',
  recipient_name: Option.some('Ultimate Frisbee Horní Počernice, z.s.'),
  registered_id: Option.some('61858374'),
  registered_address: Option.some('U Prefy 5, 193 00 Praha 9'),
  bank_name: Option.some('Fio banka, a.s.'),
  fio_token_encrypted: Option.some('v1.aaa.bbb.ccc'),
  fio_token_created_at: Option.none(),
  configured_by_user_id: userId,
});

// ---------------------------------------------------------------------------
// 96 — full-column round-trip
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — full-column round-trip (96)', () => {
  it.effect(
    'every upserted column reads back exactly — catches a silent hand-written INSERT column drop',
    () =>
      Effect.gen(function* () {
        const { user, team } = yield* setup;
        const repo = yield* BankSyncConfigRepository.asEffect();
        const input = fullUpsertInput(team.id, user.id);
        yield* repo.upsert(input as never);

        const found = yield* repo.findByTeam(team.id);
        expect(Option.isSome(found)).toBe(true);
        if (Option.isSome(found)) {
          const cfg = found.value;
          expect(cfg.enabled).toBe(true);
          expect(cfg.auto_match_enabled).toBe(true);
          expect(cfg.auto_credit_enabled).toBe(true);
          expect(cfg.auto_create_expenses).toBe(true);
          expect(cfg.account_prefix).toEqual(Option.some('19'));
          expect(cfg.account_number).toEqual(Option.some('2000145399'));
          expect(cfg.bank_code).toEqual(Option.some('0800'));
          expect(cfg.currency).toBe('CZK');
          expect(cfg.recipient_name).toEqual(Option.some('Ultimate Frisbee Horní Počernice, z.s.'));
          expect(cfg.registered_id).toEqual(Option.some('61858374'));
          expect(cfg.registered_address).toEqual(Option.some('U Prefy 5, 193 00 Praha 9'));
          expect(cfg.bank_name).toEqual(Option.some('Fio banka, a.s.'));
          expect(cfg.configured_by_user_id).toBe(user.id);
        }
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 97 / 98 — token preserved on omission; configured_by_user_id always updates
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — upsert semantics (97, 98)', () => {
  // The silent-loss path: a save from a bundle older than the server omits the flag entirely.
  // If the DO UPDATE read EXCLUDED (already COALESCEd to false in the INSERT list), every such
  // save would switch a club's auto-expense setting off without an error anywhere.
  it.effect('omitting auto_create_expenses on a second upsert PRESERVES the stored true', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      yield* repo.upsert({
        ...fullUpsertInput(team.id, user.id),
        auto_create_expenses: Option.none(),
      } as never);

      const found = yield* repo.findByTeam(team.id);
      expect(Option.isSome(found)).toBe(true);
      if (Option.isSome(found)) expect(found.value.auto_create_expenses).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('setting auto_create_expenses to false on a second upsert APPLIES it', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      yield* repo.upsert({
        ...fullUpsertInput(team.id, user.id),
        auto_create_expenses: Option.some(false),
      } as never);

      const found = yield* repo.findByTeam(team.id);
      expect(Option.isSome(found)).toBe(true);
      if (Option.isSome(found)) expect(found.value.auto_create_expenses).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('omitting the token on a second upsert PRESERVES the stored one (COALESCE)', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      yield* repo.upsert({
        ...fullUpsertInput(team.id, user.id),
        fio_token_encrypted: Option.none(),
      } as never);

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ fio_token_encrypted: string | null }>`
        SELECT fio_token_encrypted FROM bank_sync_config WHERE team_id = ${team.id}
      `;
      expect(rows[0]?.fio_token_encrypted).toBe('v1.aaa.bbb.ccc');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('configured_by_user_id re-points on every upsert', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const secondUser = yield* createUser('treasurer-2').pipe(Effect.provide(TestLayer));
      const repo = yield* BankSyncConfigRepository.asEffect();
      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);
      yield* repo.upsert(fullUpsertInput(team.id, secondUser.id) as never);

      const found = yield* repo.findByTeam(team.id);
      expect(Option.isSome(found) && found.value.configured_by_user_id).toBe(secondUser.id);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 99 — saving resets consecutive_failure_count and next_attempt_at
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — save resets backoff bookkeeping (99)', () => {
  it.effect(
    'a failing config, re-saved, has consecutive_failure_count = 0 and next_attempt_at = NULL',
    () =>
      Effect.gen(function* () {
        const { user, team } = yield* setup;
        const repo = yield* BankSyncConfigRepository.asEffect();
        yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);
        yield* repo.recordFailure(team.id, 'fio_error');
        yield* repo.recordFailure(team.id, 'fio_error');

        const beforeSave = yield* repo.findByTeam(team.id);
        expect(Option.isSome(beforeSave) && beforeSave.value.consecutive_failure_count).toBe(2);

        yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);
        const afterSave = yield* repo.findByTeam(team.id);
        if (Option.isSome(afterSave)) {
          expect(afterSave.value.consecutive_failure_count).toBe(0);
          expect(afterSave.value.next_attempt_at).toEqual(Option.none());
        }
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 100 — findPollable excludes disabled / token-less / future next_attempt_at
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — findPollable (100)', () => {
  it.effect(
    'excludes disabled, token-less, and future-next_attempt_at configs; includes an eligible one',
    () =>
      Effect.gen(function* () {
        const repo = yield* BankSyncConfigRepository.asEffect();
        const sql = yield* SqlClient.SqlClient.asEffect();

        const { user: userA, team: teamA } = yield* setup; // eligible
        yield* repo.upsert(fullUpsertInput(teamA.id, userA.id) as never);

        const userB = yield* createUser('treasurer-b');
        const teamB = yield* createTeam(nextDiscordId(), userB.id, 'Team B — disabled');
        yield* repo.upsert({ ...fullUpsertInput(teamB.id, userB.id), enabled: false } as never);

        const userC = yield* createUser('treasurer-c');
        const teamC = yield* createTeam(nextDiscordId(), userC.id, 'Team C — no token');
        yield* repo.upsert({
          ...fullUpsertInput(teamC.id, userC.id),
          fio_token_encrypted: Option.none(),
        } as never);
        // fullUpsertInput seeds no prior row, so the omitted token means no token at all here.

        const userD = yield* createUser('treasurer-d');
        const teamD = yield* createTeam(nextDiscordId(), userD.id, 'Team D — future retry');
        yield* repo.upsert(fullUpsertInput(teamD.id, userD.id) as never);
        yield* sql`UPDATE bank_sync_config SET next_attempt_at = now() + interval '1 hour' WHERE team_id = ${teamD.id}`;

        const pollable = yield* repo.findPollable();
        const pollableTeamIds = pollable.map((c) => c.team_id);
        expect(pollableTeamIds).toContain(teamA.id);
        expect(pollableTeamIds).not.toContain(teamB.id);
        expect(pollableTeamIds).not.toContain(teamC.id);
        expect(pollableTeamIds).not.toContain(teamD.id);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 101 — poll lease
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — poll lease (101)', () => {
  it.effect(
    'claiming twice in a row returns None the second time; expiry and release make it claimable again',
    () =>
      Effect.gen(function* () {
        const { user, team } = yield* setup;
        const repo = yield* BankSyncConfigRepository.asEffect();
        yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

        const first = yield* repo.claimPollLease(team.id, 'replica-1', 300);
        expect(Option.isSome(first)).toBe(true);

        const second = yield* repo.claimPollLease(team.id, 'replica-2', 300);
        expect(Option.isSome(second)).toBe(false);

        yield* repo.releasePollLease(team.id, 'replica-1');
        const third = yield* repo.claimPollLease(team.id, 'replica-2', 300);
        expect(Option.isSome(third)).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an expired lease is claimable without an explicit release', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      yield* repo.claimPollLease(team.id, 'replica-1', 300);
      yield* sql`UPDATE bank_sync_config SET poll_leased_until = now() - interval '1 second' WHERE team_id = ${team.id}`;

      const reclaimed = yield* repo.claimPollLease(team.id, 'replica-2', 300);
      expect(Option.isSome(reclaimed)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 102 / 102b — throttle reservation, autocommit invariant
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — throttle reservation (102, 102b)', () => {
  it.effect(
    'two reservations for the SAME fingerprint schedule slots >= 30s apart; different fingerprints do not interfere',
    () =>
      Effect.gen(function* () {
        const repo = yield* BankSyncConfigRepository.asEffect();
        const fingerprint = 'fp-same';
        const wait1 = yield* repo.reserveThrottleSlot(fingerprint);
        const wait2 = yield* repo.reserveThrottleSlot(fingerprint);
        // The very first reservation is near-zero; the second must reflect the 30s gap.
        expect(Duration.toMillis(wait1)).toBeLessThan(1000);
        expect(Duration.toMillis(wait2)).toBeGreaterThanOrEqual(29_000);

        const otherWait = yield* repo.reserveThrottleSlot('fp-other');
        expect(Duration.toMillis(otherWait)).toBeLessThan(1000);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'the reservation is a SINGLE statement (one row visible immediately, no intermediate state)',
    () =>
      Effect.gen(function* () {
        const repo = yield* BankSyncConfigRepository.asEffect();
        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* repo.reserveThrottleSlot('fp-single-stmt');
        const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM fio_token_throttle WHERE token_fingerprint = 'fp-single-stmt'
      `;
        expect(rows[0]?.count).toBe('1');
      }).pipe(Effect.provide(TestLayer)),
  );

  // 102b was rewritten (see AGENTS.md-adjacent review notes): the original positive test held a
  // transaction on 'fp-holder' while reserving 'fp-not-held' — DIFFERENT rows, which never block
  // each other regardless of the defect under test, and the negative control used raw SQL rather
  // than `reserveThrottleSlot` at all. Both would have passed even if the reservation were
  // wrapped in `sql.withTransaction` — precisely the bug they exist to catch. Both tests below
  // exercise the REAL `reserveThrottleSlot` on the SAME fingerprint from two genuinely separate
  // Postgres connections (`repoA` on the suite's `TestPgClient` connection, `repoB` explicitly
  // rebound to `secondTestPgClient` the same way `BankTransactionUnmatch.test.ts`'s 140b does).

  it.effect(
    '102b — production reserveThrottleSlot never holds its row lock past its own statement: a ' +
      "second connection's reservation for the SAME fingerprint, made while the first caller " +
      'sleeps the returned wait duration (simulating the real `Effect.sleep(wait)` in ' +
      'FioApiClient, done OUTSIDE the repository call), returns promptly',
    () =>
      Effect.scoped(
        // `it.effect` auto-provides a virtual `TestClock` (`@effect/vitest`'s `TestEnv`), under
        // which a bare `Effect.sleep` never resolves without an explicit `TestClock.adjust` —
        // this test needs a GENUINE elapsed-time observation of a real Postgres session lock, so
        // it opts back into the live clock via `TestClock.withLive` rather than faking time.
        TestClock.withLive(
          Effect.gen(function* () {
            const repoA = yield* BankSyncConfigRepository.asEffect();
            const sql2 = yield* secondTestPgClient;
            const repoB = yield* BankSyncConfigRepository.asEffect().pipe(
              Effect.provide(BankSyncConfigRepository.Default),
              Effect.provideService(SqlClient.SqlClient, sql2),
            );
            const fingerprint = 'fp-x';

            // Connection A reserves, then sleeps ~2s exactly as `FioApiClient` does with the
            // returned duration — but that sleep is NOT part of the reservation statement itself.
            yield* repoA.reserveThrottleSlot(fingerprint);
            const sleepFiber = yield* Effect.forkChild(Effect.sleep('2 seconds'));

            // Connection B reserves the SAME fingerprint concurrently. If the reservation were
            // (incorrectly) wrapped in a lingering transaction, this would block for ~2s.
            const start = Date.now();
            yield* repoB.reserveThrottleSlot(fingerprint);
            const elapsedMs = Date.now() - start;
            expect(elapsedMs).toBeLessThan(500);

            yield* Fiber.join(sleepFiber);
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '102b (negative control) — wrapping reserveThrottleSlot AND the caller-side sleep in ' +
      'sql.withTransaction DOES block a second connection reserving the SAME fingerprint, proving ' +
      'why the autocommit invariant matters',
    () =>
      Effect.scoped(
        // See the note on the previous test — this one also needs the LIVE clock, since it
        // measures real elapsed wall-clock time to prove a genuine Postgres row-lock wait.
        TestClock.withLive(
          Effect.gen(function* () {
            const sql1 = yield* SqlClient.SqlClient.asEffect();
            const repoA = yield* BankSyncConfigRepository.asEffect();
            const sql2 = yield* secondTestPgClient;
            const repoB = yield* BankSyncConfigRepository.asEffect().pipe(
              Effect.provide(BankSyncConfigRepository.Default),
              Effect.provideService(SqlClient.SqlClient, sql2),
            );
            const fingerprint = 'fp-negative-control';

            const heldTxFiber = yield* Effect.forkChild(
              sql1.withTransaction(
                Effect.gen(function* () {
                  yield* repoA.reserveThrottleSlot(fingerprint);
                  yield* Effect.sleep('2 seconds');
                }),
              ),
            );
            yield* Effect.sleep('100 millis'); // let connection A's transaction actually start

            const start = Date.now();
            yield* Effect.race(repoB.reserveThrottleSlot(fingerprint), Effect.sleep('1.5 seconds'));
            const elapsedMs = Date.now() - start;
            // The second connection's reservation for the SAME fingerprint must have been
            // blocked by the first connection's still-open transaction — it cannot have finished
            // before the 1.5s race timeout did.
            expect(elapsedMs).toBeGreaterThanOrEqual(1000);

            yield* Fiber.join(heldTxFiber);
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 102c — guarded lease release
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — guarded lease release (102c)', () => {
  it.effect("replica A's stale release does not clear replica B's freshly-claimed lease", () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      yield* repo.claimPollLease(team.id, 'replica-A', 300);
      // Simulate expiry without an explicit release.
      yield* sql`UPDATE bank_sync_config SET poll_leased_until = now() - interval '1 second' WHERE team_id = ${team.id}`;
      yield* repo.claimPollLease(team.id, 'replica-B', 300);

      // Replica A's (late, guarded) release must not clear B's lease.
      yield* repo.releasePollLease(team.id, 'replica-A');

      const found = yield* repo.findByTeam(team.id);
      expect(Option.isSome(found) && found.value.poll_leased_by).toEqual(Option.some('replica-B'));
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 103 — statement period upsert + continuity read-back
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — statement period upsert (103)', () => {
  it.effect(
    'an upserted period reads back exactly, and a second upsert for the same range updates it',
    () =>
      Effect.gen(function* () {
        const { user, team } = yield* setup;
        const repo = yield* BankSyncConfigRepository.asEffect();
        yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

        yield* repo.upsertStatementPeriod({
          teamId: team.id,
          dateStart: '2024-01-01',
          dateEnd: '2024-01-14',
          openingBalanceMinor: 100_000,
          closingBalanceMinor: 150_000,
          currency: 'CZK',
        } as never);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const before = yield* sql<{ closing_balance_minor: string }>`
        SELECT closing_balance_minor FROM bank_statement_periods
        WHERE team_id = ${team.id} AND date_start = '2024-01-01' AND date_end = '2024-01-14'
      `;
        expect(before[0]?.closing_balance_minor).toBe('150000');

        yield* repo.upsertStatementPeriod({
          teamId: team.id,
          dateStart: '2024-01-01',
          dateEnd: '2024-01-14',
          openingBalanceMinor: 100_000,
          closingBalanceMinor: 175_000,
          currency: 'CZK',
        } as never);

        const after = yield* sql<{ closing_balance_minor: string; count: string }>`
        SELECT closing_balance_minor, count(*) OVER ()::text AS count FROM bank_statement_periods
        WHERE team_id = ${team.id} AND date_start = '2024-01-01' AND date_end = '2024-01-14'
      `;
        expect(after[0]?.closing_balance_minor).toBe('175000');
        expect(after[0]?.count).toBe('1');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 104 — enabled-completeness CHECK
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — enabled-completeness CHECK (104)', () => {
  const insertRaw = (
    sql: SqlClient.SqlClient,
    teamId: string,
    userId: string,
    overrides: {
      accountNumber?: string | null;
      bankCode?: string | null;
      recipientName?: string | null;
    },
  ) =>
    sql`
      INSERT INTO bank_sync_config (team_id, enabled, account_number, bank_code, recipient_name, configured_by_user_id)
      VALUES (
        ${teamId}, true,
        ${overrides.accountNumber === undefined ? '2703474850' : overrides.accountNumber},
        ${overrides.bankCode === undefined ? '2010' : overrides.bankCode},
        ${overrides.recipientName === undefined ? 'Klub' : overrides.recipientName},
        ${userId}
      )
    `;

  it.effect('rejects an enabled config missing account_number', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(
        insertRaw(sql, team.id, user.id, { accountNumber: null }),
      );
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('rejects an enabled config missing bank_code', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(insertRaw(sql, team.id, user.id, { bankCode: null }));
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('rejects an enabled config missing recipient_name', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(
        insertRaw(sql, team.id, user.id, { recipientName: null }),
      );
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 105 — fio_token_saved_at is stamped only when a new token is actually written
// ---------------------------------------------------------------------------

describe('BankSyncConfigRepository — fio_token_saved_at stamping (105)', () => {
  it.effect('an insert WITH a token stamps fio_token_saved_at to roughly now', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      const found = yield* repo.findByTeam(team.id);
      expect(Option.isSome(found)).toBe(true);
      const cfg = Option.getOrThrow(found);
      expect(Option.isSome(cfg.fio_token_saved_at)).toBe(true);

      // Sanity check ONLY — not proof of server origin. The host and container clocks agree
      // in any environment you'd run this suite in, so this window would pass just as well for
      // a client-supplied value. Server origin is guaranteed structurally: the field is absent
      // from `UpsertBankSyncConfigInput` / the upsert's `Request` schema, so nothing but the
      // repository's own `now()` can ever populate it.
      const dbNowRows = yield* sql<{ now: Date }>`SELECT now()`;
      const dbNowMs = dbNowRows[0]?.now.getTime();
      const savedAtMs = DateTime.toEpochMillis(Option.getOrThrow(cfg.fio_token_saved_at));
      expect(Math.abs(savedAtMs - dbNowMs)).toBeLessThan(60_000);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an insert with NO token leaves fio_token_saved_at as Option.none()', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();

      // Fresh team, no prior row — the COALESCE-style preservation has nothing to keep, so this
      // is the true "never written" case. The enabled-completeness CHECK (104) permits
      // enabled: true without a token.
      yield* repo.upsert({
        ...fullUpsertInput(team.id, user.id),
        fio_token_encrypted: Option.none(),
      } as never);

      const found = yield* repo.findByTeam(team.id);
      expect(Option.isSome(found)).toBe(true);
      const cfg = Option.getOrThrow(found);
      expect(Option.isNone(cfg.fio_token_saved_at)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a tokenless re-upsert PRESERVES the existing fio_token_saved_at', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      // Backdate rather than compare two live stamps: `DateTimeFromDate` decodes to millisecond
      // precision while Postgres stores microseconds, so two upserts a millisecond apart can
      // decode to the same millisecond and make a live-stamp comparison intermittently flaky.
      yield* sql`UPDATE bank_sync_config SET fio_token_saved_at = '2020-01-01T00:00:00Z' WHERE team_id = ${team.id}`;

      yield* repo.upsert({
        ...fullUpsertInput(team.id, user.id),
        fio_token_encrypted: Option.none(),
      } as never);

      const found = yield* repo.findByTeam(team.id);
      const cfg = Option.getOrThrow(found);
      expect(DateTime.toEpochMillis(Option.getOrThrow(cfg.fio_token_saved_at))).toBe(
        Date.parse('2020-01-01T00:00:00.000Z'),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a replacement token ADVANCES fio_token_saved_at', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const repo = yield* BankSyncConfigRepository.asEffect();
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* repo.upsert(fullUpsertInput(team.id, user.id) as never);

      yield* sql`UPDATE bank_sync_config SET fio_token_saved_at = '2020-01-01T00:00:00Z' WHERE team_id = ${team.id}`;

      yield* repo.upsert({
        ...fullUpsertInput(team.id, user.id),
        fio_token_encrypted: Option.some('v1.xxx.yyy.zzz'),
      } as never);

      const found = yield* repo.findByTeam(team.id);
      const cfg = Option.getOrThrow(found);
      // Strict `>`, not `>=`: `>=` would also pass if the implementation never re-stamped on
      // replace, which is the exact bug this case exists to catch.
      expect(DateTime.toEpochMillis(Option.getOrThrow(cfg.fio_token_saved_at))).toBeGreaterThan(
        Date.parse('2020-01-01T00:00:00.000Z'),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});
