import { describe, expect, it } from '@effect/vitest';
import { RulesProgress } from '@sideline/domain';
import { Effect, Layer, Option, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(RulesAttemptsRepository.Default, UsersRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

/**
 * Reads `rules_scenario_results` directly by attempt id, decoding `steps`
 * (JSONB) as a plain array of `{ pick, ok }` — node-pg parses JSONB back into
 * JS automatically, so the read schema uses no `Schema.parseJson` (see
 * `RulesAttemptsRepository.ts`'s module doc). This bypasses the repository
 * entirely on purpose: it is the only way to assert the raw stored shape of
 * `steps` round-trips, since no repository method returns it.
 */
class RawResultRow extends Schema.Class<RawResultRow>('RawResultRow')({
  scenario_id: Schema.String,
  correct: Schema.Boolean,
  steps: Schema.Array(Schema.Struct({ pick: Schema.NullOr(Schema.Int), ok: Schema.Boolean })),
}) {}

const findRawResults = (attemptId: RulesProgress.RulesAttemptId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      SqlSchema.findAll({
        Request: RulesProgress.RulesAttemptId,
        Result: RawResultRow,
        execute: (id) => sql`
          SELECT scenario_id, correct, steps FROM rules_scenario_results
          WHERE attempt_id = ${id}
          ORDER BY scenario_id
        `,
      })(attemptId),
    ),
  );

const clearFinishedAt = (attemptId: RulesProgress.RulesAttemptId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`UPDATE rules_attempts SET finished_at = NULL WHERE id = ${attemptId}`,
    ),
  );

/** Backdates `finished_at` to a known-past instant via raw SQL, so a later
 * attempt's default `now()` is unambiguously the MAX. */
const backdateFinishedAt = (attemptId: RulesProgress.RulesAttemptId, isoDate: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`UPDATE rules_attempts SET finished_at = ${isoDate}::timestamptz WHERE id = ${attemptId}`,
    ),
  );

// ---------------------------------------------------------------------------
// insertAttempt
// ---------------------------------------------------------------------------

describe('RulesAttemptsRepository — insertAttempt', () => {
  it.effect('inserts a completed attempt row with finished_at set', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000001', 'rules-user-1')),
      Effect.bind('attempt', ({ userId }) =>
        RulesAttemptsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertAttempt(userId, 'practice', [1, 2], 3, 5)),
        ),
      ),
      Effect.tap(({ attempt, userId }) =>
        Effect.sync(() => {
          expect(attempt.user_id).toBe(userId);
          expect(attempt.mode).toBe('practice');
          expect(attempt.packages).toEqual([1, 2]);
          expect(attempt.score).toBe(3);
          expect(attempt.total).toBe(5);
          expect(Option.isSome(attempt.finished_at)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// insertResults — multi-row VALUES insert (>= 2 rows)
// ---------------------------------------------------------------------------

describe('RulesAttemptsRepository — insertResults (multi-row insert)', () => {
  it.effect('inserts multiple scenario results in one statement and round-trips steps JSONB', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000002', 'rules-user-2')),
      Effect.bind('attempt', ({ userId }) =>
        RulesAttemptsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertAttempt(userId, 'exam', [1, 2, 3], 2, 3)),
        ),
      ),
      Effect.tap(({ attempt }) =>
        RulesAttemptsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertResults(attempt.id, [
              {
                scenario_id: 'p1-s1',
                correct: true,
                steps: [
                  { pick: 0, ok: true },
                  { pick: null, ok: false },
                ],
              },
              {
                scenario_id: 'p1-s2',
                correct: false,
                steps: [{ pick: 2, ok: false }],
              },
              {
                scenario_id: 'p1-s3',
                correct: true,
                steps: [{ pick: 1, ok: true }],
              },
            ]),
          ),
        ),
      ),
      Effect.bind('rows', ({ attempt }) => findRawResults(attempt.id)),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(3);
          expect(rows.map((r) => r.scenario_id)).toEqual(['p1-s1', 'p1-s2', 'p1-s3']);
          expect(rows[0]?.correct).toBe(true);
          expect(rows[0]?.steps).toEqual([
            { pick: 0, ok: true },
            { pick: null, ok: false },
          ]);
          expect(rows[1]?.correct).toBe(false);
          expect(rows[1]?.steps).toEqual([{ pick: 2, ok: false }]);
          expect(rows[2]?.steps).toEqual([{ pick: 1, ok: true }]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('is a no-op for an empty results array', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000003', 'rules-user-3')),
      Effect.bind('attempt', ({ userId }) =>
        RulesAttemptsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertAttempt(userId, 'practice', [1], 0, 0)),
        ),
      ),
      Effect.tap(({ attempt }) =>
        RulesAttemptsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.insertResults(attempt.id, [])),
        ),
      ),
      Effect.bind('rows', ({ attempt }) => findRawResults(attempt.id)),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// lastCorrectByScenario
// ---------------------------------------------------------------------------

describe('RulesAttemptsRepository — lastCorrectByScenario', () => {
  it.effect(
    'only counts correct results from finished attempts, MAX wins, excludes other users',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('900000000000000004', 'rules-user-4')),
        Effect.bind('otherUserId', () => createUser('900000000000000005', 'rules-user-5')),

        // Attempt 1 (finished): scenario 'a' correct, scenario 'b' incorrect.
        Effect.bind('attempt1', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'practice', [1], 1, 2)),
          ),
        ),
        Effect.tap(({ attempt1 }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertResults(attempt1.id, [
                { scenario_id: 'a', correct: true, steps: [{ pick: 0, ok: true }] },
                { scenario_id: 'b', correct: false, steps: [{ pick: 1, ok: false }] },
              ]),
            ),
          ),
        ),
        // Backdate attempt1 so attempt2's default now() is unambiguously the MAX.
        Effect.tap(({ attempt1 }) => backdateFinishedAt(attempt1.id, '2020-01-01T00:00:00Z')),

        // Attempt 2 (finished, later): scenario 'a' correct again — MAX(finished_at) must win.
        Effect.bind('attempt2', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'practice', [1], 1, 1)),
          ),
        ),
        Effect.tap(({ attempt2 }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertResults(attempt2.id, [
                { scenario_id: 'a', correct: true, steps: [{ pick: 0, ok: true }] },
              ]),
            ),
          ),
        ),

        // Attempt 3: correct result on scenario 'c', but the attempt itself is
        // NOT finished (finished_at cleared via raw SQL — the repository never
        // produces this today, but the WHERE guard must still hold).
        Effect.bind('attempt3', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'practice', [1], 1, 1)),
          ),
        ),
        Effect.tap(({ attempt3 }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertResults(attempt3.id, [
                { scenario_id: 'c', correct: true, steps: [{ pick: 0, ok: true }] },
              ]),
            ),
          ),
        ),
        Effect.tap(({ attempt3 }) => clearFinishedAt(attempt3.id)),

        // Another user's correct result on scenario 'a' must never leak in.
        Effect.bind('otherAttempt', ({ otherUserId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(otherUserId, 'practice', [1], 1, 1)),
          ),
        ),
        Effect.tap(({ otherAttempt }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertResults(otherAttempt.id, [
                { scenario_id: 'a', correct: true, steps: [{ pick: 0, ok: true }] },
              ]),
            ),
          ),
        ),

        Effect.bind('rows', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.lastCorrectByScenario(userId)),
          ),
        ),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            const byScenario = new Map(rows.map((r) => [r.scenario_id, r.last_correct_at]));
            // 'b' was never correct → absent.
            expect(byScenario.has('b')).toBe(false);
            // 'c' was correct but its attempt is unfinished → absent.
            expect(byScenario.has('c')).toBe(false);
            // 'a' is present, and its last_correct_at reflects the LATER (attempt2) finish,
            // not the backdated attempt1 one — proving MAX(finished_at) wins.
            expect(byScenario.has('a')).toBe(true);
            const aTimestamp = byScenario.get('a');
            expect(aTimestamp).toBeDefined();
            if (aTimestamp !== undefined) {
              expect(aTimestamp.epochMilliseconds).toBeGreaterThan(
                new Date('2021-01-01').getTime(),
              );
            }
            expect(rows).toHaveLength(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
