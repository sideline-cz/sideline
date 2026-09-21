// TDD mode — tests written BEFORE `BankTransactionsRepository.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D4 / D16 / §7.2 tests 105-115.
//
// Contract this file pins down for
// `applications/server/src/repositories/BankTransactionsRepository.ts`:
//
//   upsertMany(teamId, movements: ReadonlyArray<FioMovementInsert>): Effect<ReadonlyArray<BankTransaction>>
//     — ON CONFLICT (team_id, provider, fio_movement_id) DO UPDATE SET raw = ..., updated_at = now()
//       (never resets match_state or clears any match link); `ingested_at` untouched on conflict.
//       Uses `sql.join(',', false)` for a multi-row VALUES list.
//   findById(id): Effect<Option<BankTransaction>>
//   ignore(id, { kind, reason, ignoredByUserId }): Effect<BankTransaction>
//     — the CHECK on match_state='ignored' requires reason + ignoredByUserId + resolution_kind together.

import { describe, expect, it } from '@effect/vitest';
import { BankTransaction } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  BankTransactionsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const setup = Effect.gen(function* () {
  const user = yield* createUser('treasurer');
  const team = yield* createTeam(nextDiscordId(), user.id);
  return { user, team };
});

const movement = (overrides: Record<string, unknown> = {}) => ({
  fio_movement_id: 100001,
  booked_on: '2024-03-01',
  amount_minor: 15000,
  currency: 'CZK',
  variable_symbol: Option.some('12345'),
  counterparty_name: Option.some('Jan Novák'),
  raw: { column22: { value: 100001 } },
  ...overrides,
});

// ---------------------------------------------------------------------------
// 105 — upsertMany idempotency; ingested_at unchanged on re-import
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — upsertMany idempotency (105)', () => {
  it.effect('upserting the same movement twice yields exactly one row, ingested_at unchanged', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [movement()] as never);

      const sql = yield* SqlClient.SqlClient.asEffect();
      const first = yield* sql<{ id: string; ingested_at: Date }>`
        SELECT id, ingested_at FROM bank_transactions WHERE team_id = ${team.id}
      `;
      expect(first).toHaveLength(1);

      yield* repo.upsertMany(team.id, [movement()] as never);
      const second = yield* sql<{ id: string; ingested_at: Date; count: string }>`
        SELECT id, ingested_at, count(*) OVER ()::text AS count FROM bank_transactions WHERE team_id = ${team.id}
      `;
      expect(second).toHaveLength(1);
      expect(second[0]?.id).toBe(first[0]?.id);
      expect(new Date(second[0]?.ingested_at ?? 0).getTime()).toBe(
        new Date(first[0]?.ingested_at ?? 0).getTime(),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 106 — re-import with a changed payload updates raw but never resets match_state
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — re-import preserves match state (106)', () => {
  it.effect('a changed raw payload updates raw but does not touch match_state', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* repo.upsertMany(team.id, [movement()] as never);
      yield* sql`UPDATE bank_transactions SET match_state = 'matched' WHERE team_id = ${team.id}`;

      yield* repo.upsertMany(team.id, [
        movement({ raw: { column22: { value: 100001 }, changed: true } }),
      ] as never);

      const rows = yield* sql<{ match_state: string; raw: unknown }>`
        SELECT match_state, raw FROM bank_transactions WHERE team_id = ${team.id}
      `;
      expect(rows[0]?.match_state).toBe('matched');
      expect(JSON.stringify(rows[0]?.raw)).toContain('changed');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 107 — same fio_movement_id under two teams -> two rows
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — per-team uniqueness (107)', () => {
  it.effect('the same fio_movement_id under two different teams produces two rows', () =>
    Effect.gen(function* () {
      const userA = yield* createUser('treasurer-a');
      const teamA = yield* createTeam(nextDiscordId(), userA.id, 'Team A');
      const userB = yield* createUser('treasurer-b');
      const teamB = yield* createTeam(nextDiscordId(), userB.id, 'Team B');
      const repo = yield* BankTransactionsRepository.asEffect();

      yield* repo.upsertMany(teamA.id, [movement()] as never);
      yield* repo.upsertMany(teamB.id, [movement()] as never);

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM bank_transactions WHERE fio_movement_id = 100001
      `;
      expect(rows[0]?.count).toBe('2');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 108 / 109 / 110 / 111 — signed amount, direction, BIGINT-as-string, date, JSONB round-trip
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — column round-trips (108, 109, 110, 111)', () => {
  it.effect('a negative amount produces a generated direction of "outgoing"', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [
        movement({ fio_movement_id: 200001, amount_minor: -5000 }),
      ] as never);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ direction: string }>`
        SELECT direction FROM bank_transactions WHERE team_id = ${team.id} AND fio_movement_id = 200001
      `;
      expect(rows[0]?.direction).toBe('outgoing');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a positive amount produces a generated direction of "incoming"', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [
        movement({ fio_movement_id: 200002, amount_minor: 5000 }),
      ] as never);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ direction: string }>`
        SELECT direction FROM bank_transactions WHERE team_id = ${team.id} AND fio_movement_id = 200002
      `;
      expect(rows[0]?.direction).toBe('incoming');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('amount_minor = 0 is rejected by the CHECK', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(sql`
        INSERT INTO bank_transactions (team_id, fio_movement_id, booked_on, amount_minor, currency, match_state, raw)
        VALUES (${team.id}, 300001, '2024-03-01', 0, 'CZK', 'not_applicable', '{}'::jsonb)
      `);
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a large BIGINT fio_movement_id round-trips exactly through the domain decoder', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [
        movement({ fio_movement_id: 12345678901, amount_minor: 100 }),
      ] as never);
      const found = yield* repo.listByTeam(team.id, {} as never);
      const row = found.find(
        (r: { fio_movement_id: unknown }) => String(r.fio_movement_id) === '12345678901',
      );
      expect(row).toBeDefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("booked_on round-trips as 'YYYY-MM-DD' text, not a Date shifted by timezone", () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [
        movement({ fio_movement_id: 400001, booked_on: '2024-12-31', amount_minor: 100 }),
      ] as never);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ booked_on_text: string }>`
        SELECT booked_on::text AS booked_on_text FROM bank_transactions
        WHERE team_id = ${team.id} AND fio_movement_id = 400001
      `;
      expect(rows[0]?.booked_on_text).toBe('2024-12-31');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('raw JSONB round-trips', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [
        movement({ fio_movement_id: 500001, amount_minor: 100, raw: { nested: { a: [1, 2, 3] } } }),
      ] as never);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ raw: { nested: { a: Array<number> } } }>`
        SELECT raw FROM bank_transactions WHERE team_id = ${team.id} AND fio_movement_id = 500001
      `;
      expect(rows[0]?.raw.nested.a).toEqual([1, 2, 3]);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 112 — the ignore/resolution_kind CHECK
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — ignore CHECK constraints (112)', () => {
  const insertUnmatched = (sql: SqlClient.SqlClient, teamId: string, movementId: number) =>
    sql<{ id: string }>`
      INSERT INTO bank_transactions (team_id, fio_movement_id, booked_on, amount_minor, currency, raw)
      VALUES (${teamId}, ${movementId}, '2024-03-01', 100, 'CZK', '{}'::jsonb)
      RETURNING id
    `;

  it.effect('ignored without a reason violates the CHECK', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const [row] = yield* insertUnmatched(sql, team.id, 600001);
      const result = yield* Effect.result(sql`
        UPDATE bank_transactions SET match_state = 'ignored', ignored_by_user_id = ${user.id}, resolution_kind = 'not_relevant'
        WHERE id = ${row?.id}
      `);
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('ignored without ignored_by_user_id violates the CHECK', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const [row] = yield* insertUnmatched(sql, team.id, 600002);
      const result = yield* Effect.result(sql`
        UPDATE bank_transactions SET match_state = 'ignored', ignored_reason = 'test', resolution_kind = 'not_relevant'
        WHERE id = ${row?.id}
      `);
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('ignored without resolution_kind violates the CHECK', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const [row] = yield* insertUnmatched(sql, team.id, 600003);
      const result = yield* Effect.result(sql`
        UPDATE bank_transactions SET match_state = 'ignored', ignored_reason = 'test', ignored_by_user_id = ${user.id}
        WHERE id = ${row?.id}
      `);
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a resolution_kind on a non-ignored row violates the CHECK', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const [row] = yield* insertUnmatched(sql, team.id, 600004);
      const result = yield* Effect.result(sql`
        UPDATE bank_transactions SET resolution_kind = 'not_relevant' WHERE id = ${row?.id}
      `);
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a fully-populated ignore is accepted', () =>
    Effect.gen(function* () {
      const { user, team } = yield* setup;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const [row] = yield* insertUnmatched(sql, team.id, 600005);
      yield* sql`
        UPDATE bank_transactions
        SET match_state = 'ignored', ignored_reason = 'Duplikát', ignored_by_user_id = ${user.id}, resolution_kind = 'not_relevant'
        WHERE id = ${row?.id}
      `;
      const found = yield* sql<{
        match_state: string;
      }>`SELECT match_state FROM bank_transactions WHERE id = ${row?.id}`;
      expect(found[0]?.match_state).toBe('ignored');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 113 — a multi-row upsertMany exercises sql.join(',', false)
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — multi-row upsertMany (113)', () => {
  it.effect(
    'two rows in one upsertMany call both persist (a single-row call hides the addParens bug)',
    () =>
      Effect.gen(function* () {
        const { team } = yield* setup;
        const repo = yield* BankTransactionsRepository.asEffect();
        yield* repo.upsertMany(team.id, [
          movement({ fio_movement_id: 700001, amount_minor: 100 }),
          movement({ fio_movement_id: 700002, amount_minor: 200 }),
        ] as never);
        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM bank_transactions
        WHERE team_id = ${team.id} AND fio_movement_id IN (700001, 700002)
      `;
        expect(rows[0]?.count).toBe('2');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 114 — match_reason CHECK rejects a literal outside the union
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — match_reason CHECK (114)', () => {
  it.effect(
    'a match_reason outside BankTransactionMatchReason is rejected, including possible_duplicate',
    () =>
      Effect.gen(function* () {
        const { team } = yield* setup;
        const sql = yield* SqlClient.SqlClient.asEffect();
        const bogus = yield* Effect.result(sql`
        INSERT INTO bank_transactions (team_id, fio_movement_id, booked_on, amount_minor, currency, match_reason, raw)
        VALUES (${team.id}, 800001, '2024-03-01', 100, 'CZK', 'bogus_reason', '{}'::jsonb)
      `);
        expect(bogus._tag).toBe('Failure');

        const duplicate = yield* Effect.result(sql`
        INSERT INTO bank_transactions (team_id, fio_movement_id, booked_on, amount_minor, currency, match_reason, raw)
        VALUES (${team.id}, 800002, '2024-03-01', 100, 'CZK', 'possible_duplicate', '{}'::jsonb)
      `);
        expect(duplicate._tag).toBe('Failure');

        // Sanity: every real literal IS accepted.
        for (const reason of BankTransaction.BankTransactionMatchReason.literals) {
          const ok = yield* Effect.result(sql`
          INSERT INTO bank_transactions (team_id, fio_movement_id, booked_on, amount_minor, currency, match_reason, raw)
          VALUES (${team.id}, ${800100 + BankTransaction.BankTransactionMatchReason.literals.indexOf(reason)}, '2024-03-01', 100, 'CZK', ${reason}, '{}'::jsonb)
        `);
          expect(ok._tag, `reason ${reason} should be accepted`).toBe('Success');
        }
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 115 — outgoing rows ingest as not_applicable and are absent from the queue
// ---------------------------------------------------------------------------

describe('BankTransactionsRepository — outgoing rows never reach the queue (115)', () => {
  it.effect('an outgoing movement ingests as not_applicable', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [
        movement({ fio_movement_id: 900001, amount_minor: -2500 }),
      ] as never);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ match_state: string }>`
        SELECT match_state FROM bank_transactions WHERE team_id = ${team.id} AND fio_movement_id = 900001
      `;
      expect(rows[0]?.match_state).toBe('not_applicable');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('the queue index/query excludes not_applicable rows', () =>
    Effect.gen(function* () {
      const { team } = yield* setup;
      const repo = yield* BankTransactionsRepository.asEffect();
      yield* repo.upsertMany(team.id, [
        movement({ fio_movement_id: 900002, amount_minor: -2500 }),
        movement({ fio_movement_id: 900003, amount_minor: 2500 }),
      ] as never);
      const found = yield* repo.listByTeam(team.id, { state: Option.some('unmatched') } as never);
      const ids = found.map((r: { fio_movement_id: unknown }) => String(r.fio_movement_id));
      expect(ids).not.toContain('900002');
      expect(ids).toContain('900003');
    }).pipe(Effect.provide(TestLayer)),
  );
});
