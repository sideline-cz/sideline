// Migration test for `1793200000_training_period_fees.ts` (Slice 3b of "Setup memberships" —
// per-training charging via PERIOD ACCUMULATION). Pattern: `membershipSelection.test.ts` /
// `eventAttendance.test.ts` — asserts the SCHEMA this migration leaves behind (columns,
// constraints, the partial unique index), never Postgres's own enforcement in the abstract.
//
// The charge-engine behaviour itself (the three plpgsql functions, the two triggers) is covered
// by `test/integration/repositories/trainingPeriodCharges.test.ts` — this file is scoped to the
// DDL: `fees.kind`/`fees.period_start`, the two-sided CHECK linking them, the partial unique
// index (and its predicate NOT mentioning `archived_at` — that pins the period-close design,
// see the migration's own S3 comment), and `training_period_start`'s timezone fallback.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId, setTeamTimezone } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(TeamsRepository.Default, UsersRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('training-period-fees-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.map(({ team }) => team),
);

const isFailure23514 = (result: { readonly _tag: string }) => {
  expect(result._tag).toBe('Failure');
  expect(JSON.stringify(result).toLowerCase()).toContain('23514');
};

const isFailure23505 = (result: { readonly _tag: string }) => {
  expect(result._tag).toBe('Failure');
  expect(JSON.stringify(result).toLowerCase()).toContain('23505');
};

// ---------------------------------------------------------------------------
// 1-2. Column shape
// ---------------------------------------------------------------------------

describe('fees — kind and period_start columns', () => {
  it.effect("kind is NOT NULL, defaults to 'manual'", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{
        is_nullable: string;
        column_default: string | null;
      }>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fees' AND column_name = 'kind'
      `;
      expect(cols).toHaveLength(1);
      expect(cols[0]?.is_nullable).toBe('NO');
      expect(cols[0]?.column_default).toContain('manual');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the kind CHECK rejects a value outside ('manual','training') with 23514", () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind)
          VALUES (${team.id}, 'Bad kind', 100, 'CZK', 'x')
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('period_start is a nullable date', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ data_type: string; is_nullable: string }>`
        SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fees' AND column_name = 'period_start'
      `;
      expect(cols).toHaveLength(1);
      expect(cols[0]?.data_type).toBe('date');
      expect(cols[0]?.is_nullable).toBe('YES');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 3. (kind='training') = (period_start IS NOT NULL)
// ---------------------------------------------------------------------------

describe('fees — kind/period_start CHECK is two-sided', () => {
  it.effect("kind='training' with period_start NULL raises 23514", () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
          VALUES (${team.id}, 'Training shell', 100, 'CZK', 'training', NULL)
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("kind='manual' with a period_start set raises 23514", () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
          VALUES (${team.id}, 'Manual with period', 100, 'CZK', 'manual', '2026-09-01')
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("kind='training' with a period_start set succeeds (control)", () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
          VALUES (${team.id}, '2026-09', 100, 'CZK', 'training', '2026-09-01')
        `,
      );
      expect(result._tag).toBe('Success');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 4. The partial unique index and its predicate
// ---------------------------------------------------------------------------

describe('fees — idx_fees_team_period_currency', () => {
  it.effect(
    "exists on (team_id, period_start, currency) WHERE kind = 'training', and its predicate " +
      'does NOT mention archived_at — the period close is on the calendar date, never on ' +
      'archiving (see the migration S3 comment: closing via archived_at would hide the fee ' +
      'from every reminder CTE, which all require archived_at IS NULL).',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{ indexdef: string }>`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'fees'
            AND indexname = 'idx_fees_team_period_currency'
        `;
        expect(rows).toHaveLength(1);
        const def = rows[0]?.indexdef ?? '';
        expect(def).toContain('team_id');
        expect(def).toContain('period_start');
        expect(def).toContain('currency');
        expect(def.toLowerCase()).toContain("kind = 'training'".toLowerCase());
        expect(def.toLowerCase()).not.toContain('archived_at');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 5-6. Uniqueness scope
// ---------------------------------------------------------------------------

describe('fees — training uniqueness is scoped by currency; manual fees stay unconstrained', () => {
  it.effect(
    'two training fees, same team + period, DIFFERENT currency both insert; same currency 23505s',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam;
        const sql = yield* SqlClient.SqlClient.asEffect();

        const czk = yield* Effect.result(
          sql`
            INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
            VALUES (${team.id}, '2026-09', 0, 'CZK', 'training', '2026-09-01')
          `,
        );
        expect(czk._tag).toBe('Success');

        const eur = yield* Effect.result(
          sql`
            INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
            VALUES (${team.id}, '2026-09', 0, 'EUR', 'training', '2026-09-01')
          `,
        );
        expect(eur._tag).toBe('Success');

        const dupeCzk = yield* Effect.result(
          sql`
            INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
            VALUES (${team.id}, '2026-09 dupe', 0, 'CZK', 'training', '2026-09-01')
          `,
        );
        isFailure23505(dupeCzk);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('two manual fees, same team, same day, same currency both insert (unconstrained)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const first = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, due_at)
          VALUES (${team.id}, 'Kit fee', 500, 'CZK', '2026-10-01')
        `,
      );
      expect(first._tag).toBe('Success');

      const second = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, due_at)
          VALUES (${team.id}, 'Tournament fee', 500, 'CZK', '2026-10-01')
        `,
      );
      expect(second._tag).toBe('Success');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 7. training_period_start — timezone-aware, with a UTC fallback
// ---------------------------------------------------------------------------

describe('training_period_start(p_start_at, p_team_id)', () => {
  it.effect(
    "with team_settings.timezone = 'Europe/Prague', 2026-09-30T23:30:00Z (01:30 local, " +
      'Oct 1st) resolves to 2026-10-01 — the case a UTC-month implementation gets wrong',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam;
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        const sql = yield* SqlClient.SqlClient.asEffect();

        const rows = yield* sql<{ period_start: string }>`
          SELECT training_period_start('2026-09-30T23:30:00Z'::timestamptz, ${team.id})::text AS period_start
        `;
        expect(rows[0]?.period_start).toBe('2026-10-01');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('with NO team_settings row at all, falls back to UTC', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      // No setTeamTimezone call — team_settings has no row for this team.
      const rows = yield* sql<{ period_start: string }>`
        SELECT training_period_start('2026-09-30T23:30:00Z'::timestamptz, ${team.id})::text AS period_start
      `;
      // In UTC, 2026-09-30T23:30:00Z is still September.
      expect(rows[0]?.period_start).toBe('2026-09-01');
    }).pipe(Effect.provide(TestLayer)),
  );
});
