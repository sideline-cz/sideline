import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { RulesProgress } from '@sideline/domain';
import { Effect, Layer, Option, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  RulesAttemptsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

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

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Rules Leaderboard Test Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
    Effect.map((t) => t.id),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
    Effect.map((m) => m.id),
  );

const deactivateTeamMember = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.deactivateMemberByIds(teamId, memberId)),
  );

/**
 * Inserts one finished attempt with its results in a single bindable step —
 * keeps the `lastCorrectByScenarioForTeam` fixture's `Effect.Do.pipe` chain
 * well under the ~20-argument `pipe` overload ceiling (see effect-lib
 * conventions) by collapsing "insert attempt + insert results + optionally
 * backdate/clear finished_at" into one `Effect.bind` per attempt instead of
 * three or four.
 */
const insertFinishedAttempt = (
  userId: User.UserId,
  results: ReadonlyArray<{
    readonly scenario_id: string;
    readonly correct: boolean;
    readonly steps: ReadonlyArray<{ readonly pick: number | null; readonly ok: boolean }>;
  }>,
  options?: { readonly backdateIso?: string; readonly clearFinishedAt?: boolean },
) =>
  RulesAttemptsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo
        .insertAttempt(
          userId,
          'practice',
          [1],
          results.filter((r) => r.correct).length,
          results.length,
        )
        .pipe(
          Effect.tap((attempt) => repo.insertResults(attempt.id, results)),
          Effect.tap((attempt) =>
            options?.backdateIso !== undefined
              ? backdateFinishedAt(attempt.id, options.backdateIso)
              : Effect.void,
          ),
          Effect.tap((attempt) =>
            options?.clearFinishedAt === true ? clearFinishedAt(attempt.id) : Effect.void,
          ),
        ),
    ),
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

// ---------------------------------------------------------------------------
// getExamStats (Phase 3b of docs/plans/rules-trainer.md's step 15)
// ---------------------------------------------------------------------------

describe('RulesAttemptsRepository — getExamStats', () => {
  it.effect(
    'counts finished exam attempts, only perfect (score=total, total>0) exams as perfect, excludes practice mode, unfinished attempts, and other users',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('900000000000000020', 'exam-stats-user')),
        Effect.bind('otherUserId', () => createUser('900000000000000021', 'exam-stats-other')),

        // Finished exam, perfect score (3/3) — counts as both a completed AND a perfect exam.
        Effect.bind('perfectExam', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'exam', [1], 3, 3)),
          ),
        ),

        // Finished exam, imperfect score (2/3) — completed, but not perfect.
        Effect.bind('imperfectExam', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'exam', [1], 2, 3)),
          ),
        ),

        // Finished exam with total=0, score=0 — `score = total` is trivially
        // true here, so the `total > 0` guard must exclude it from
        // `perfect_exams` (a zero-question attempt is not a perfect exam).
        Effect.bind('zeroQuestionExam', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'exam', [1], 0, 0)),
          ),
        ),

        // Finished PRACTICE attempt, perfect score — must never count towards
        // either exam stat (mode != 'exam').
        Effect.tap(({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'practice', [1], 5, 5)),
          ),
        ),

        // Unfinished exam attempt (finished_at cleared) — must be excluded
        // from `exams_completed`, mirroring the `finished_at IS NOT NULL`
        // guard on `lastCorrectByScenario` above.
        Effect.bind('unfinishedExam', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(userId, 'exam', [1], 4, 4)),
          ),
        ),
        Effect.tap(({ unfinishedExam }) => clearFinishedAt(unfinishedExam.id)),

        // Another user's perfect finished exam must never leak into this user's stats.
        Effect.tap(({ otherUserId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.insertAttempt(otherUserId, 'exam', [1], 1, 1)),
          ),
        ),

        Effect.bind('stats', ({ userId }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getExamStats(userId)),
          ),
        ),
        Effect.tap(({ stats }) =>
          Effect.sync(() => {
            // 3 finished exams count: perfectExam, imperfectExam, zeroQuestionExam.
            // practice and the unfinished exam are excluded.
            expect(stats.exams_completed).toBe(3);
            // Only perfectExam counts — zeroQuestionExam is excluded by the
            // `total > 0` guard despite satisfying `score = total`.
            expect(stats.perfect_exams).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('returns zero counts for a user with no rules attempts at all', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000022', 'exam-stats-none')),
      Effect.bind('stats', ({ userId }) =>
        RulesAttemptsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getExamStats(userId)),
        ),
      ),
      Effect.tap(({ stats }) =>
        Effect.sync(() => {
          expect(stats.exams_completed).toBe(0);
          expect(stats.perfect_exams).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// lastCorrectByScenarioForTeam (Phase 3a of docs/plans/rules-trainer.md)
// ---------------------------------------------------------------------------

describe('RulesAttemptsRepository — lastCorrectByScenarioForTeam', () => {
  it.effect(
    'includes a no-attempt member with null scenario data, excludes inactive members and other teams, only correct+finished results count, MAX wins for a repeated scenario',
    () =>
      Effect.Do.pipe(
        Effect.bind('userA', () => createUser('900000000000000010', 'team-a-active')),
        Effect.bind('userB', () => createUser('900000000000000011', 'team-a-no-attempts')),
        Effect.bind('userC', () => createUser('900000000000000012', 'team-a-inactive')),
        Effect.bind('userOther', () => createUser('900000000000000013', 'team-b-member')),

        Effect.bind('teamA', ({ userA }) =>
          createTeam('800000000000000001' as Discord.Snowflake, userA),
        ),
        Effect.bind('teamB', ({ userOther }) =>
          createTeam('800000000000000002' as Discord.Snowflake, userOther),
        ),

        Effect.bind('memberA', ({ teamA, userA }) => addTeamMember(teamA, userA)),
        Effect.bind('memberB', ({ teamA, userB }) => addTeamMember(teamA, userB)),
        Effect.bind('memberC', ({ teamA, userC }) => addTeamMember(teamA, userC)),
        Effect.bind('memberOther', ({ teamB, userOther }) => addTeamMember(teamB, userOther)),

        // memberC is deactivated — must be excluded entirely from teamA's rows.
        Effect.tap(({ teamA, memberC }) => deactivateTeamMember(teamA, memberC)),

        // userA — attempt1 (finished, backdated): correct on 'x', INCORRECT on 'y'.
        Effect.bind('attempt1', ({ userA }) =>
          insertFinishedAttempt(
            userA,
            [
              { scenario_id: 'x', correct: true, steps: [{ pick: 0, ok: true }] },
              { scenario_id: 'y', correct: false, steps: [{ pick: 1, ok: false }] },
            ],
            { backdateIso: '2020-01-01T00:00:00Z' },
          ),
        ),

        // userA — attempt2 (finished, LATER): correct on 'x' again — MAX(finished_at) must win.
        Effect.bind('attempt2', ({ userA }) =>
          insertFinishedAttempt(userA, [
            { scenario_id: 'x', correct: true, steps: [{ pick: 0, ok: true }] },
          ]),
        ),

        // userA — attempt3: correct on 'z', but the attempt itself is unfinished — must
        // never surface (mirrors the finished_at guard in lastCorrectByScenario above).
        Effect.bind('attempt3', ({ userA }) =>
          insertFinishedAttempt(
            userA,
            [{ scenario_id: 'z', correct: true, steps: [{ pick: 0, ok: true }] }],
            { clearFinishedAt: true },
          ),
        ),

        // Another team's member has a correct result too — must never leak into teamA's rows.
        Effect.bind('otherAttempt', ({ userOther }) =>
          insertFinishedAttempt(userOther, [
            { scenario_id: 'x', correct: true, steps: [{ pick: 0, ok: true }] },
          ]),
        ),

        Effect.bind('rows', ({ teamA }) =>
          RulesAttemptsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.lastCorrectByScenarioForTeam(teamA)),
          ),
        ),
        Effect.tap(({ rows, memberA, memberB, memberC, memberOther }) =>
          Effect.sync(() => {
            const memberIds = new Set(rows.map((r) => r.team_member_id));

            // memberA: has real scenario data.
            expect(memberIds.has(memberA)).toBe(true);
            // memberB: never attempted anything — still present (LEFT JOIN, no HAVING),
            // with null scenario data — this is the point of the LEFT JOIN decision.
            expect(memberIds.has(memberB)).toBe(true);
            // memberC: inactive — excluded entirely by `tm.active = true`.
            expect(memberIds.has(memberC)).toBe(false);
            // memberOther: different team — excluded entirely by `tm.team_id = teamId`.
            expect(memberIds.has(memberOther)).toBe(false);

            // No row anywhere carries an incorrect ('y') or unfinished-attempt ('z')
            // scenario id — both must be invisible, not merely deprioritized.
            const scenarioIds = new Set(
              rows.flatMap((r) => (Option.isSome(r.scenario_id) ? [r.scenario_id.value] : [])),
            );
            expect(scenarioIds.has('y')).toBe(false);
            expect(scenarioIds.has('z')).toBe(false);

            const memberARows = rows.filter((r) => r.team_member_id === memberA);
            expect(memberARows).toHaveLength(1);
            expect(Option.getOrNull(memberARows[0].scenario_id)).toBe('x');
            const memberALastCorrect = memberARows[0].last_correct_at;
            expect(Option.isSome(memberALastCorrect)).toBe(true);
            if (Option.isSome(memberALastCorrect)) {
              // Reflects attempt2's LATER finish, not attempt1's backdated one.
              expect(memberALastCorrect.value.epochMilliseconds).toBeGreaterThan(
                new Date('2021-01-01').getTime(),
              );
            }

            const memberBRows = rows.filter((r) => r.team_member_id === memberB);
            expect(memberBRows).toHaveLength(1);
            expect(Option.isNone(memberBRows[0].scenario_id)).toBe(true);
            expect(Option.isNone(memberBRows[0].last_correct_at)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
