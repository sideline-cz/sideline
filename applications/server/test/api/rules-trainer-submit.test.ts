// Tests for RulesTrainerApiLive's `submitAttempt` handler — specifically the
// best-effort achievement-evaluation hook added in Phase 3b of
// `docs/plans/rules-trainer.md`'s step 15. Uses a minimal single-group
// `HttpApi` (mirrors `test/api/DashboardLayout.test.ts`'s pattern) rather
// than the full `ApiLive` mock cascade, since only the `rulesTrainer` group
// is under test.

import type { Auth, Team, TeamMember, User } from '@sideline/domain';
import { RulesProgress, RulesTrainerApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { describe, expect, it } from 'vitest';
import { RulesTrainerApiLive } from '~/api/rules-trainer.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import type { InsertableScenarioResult } from '~/repositories/RulesAttemptsRepository.js';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const now = DateTime.nowUnsafe();

const TEST_USER_ID = '00000000-0000-0000-0006-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0006-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0006-000000000011' as TeamMember.TeamMemberId;

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  create: () => Effect.die(new Error('Not implemented')),
  findByToken: (token: string) =>
    token === 'member-token'
      ? Effect.succeed(
          Option.some({
            id: 'session-1',
            user_id: TEST_USER_ID,
            token,
            expires_at: now,
            created_at: now,
          }),
        )
      : Effect.succeed(Option.none()),
  deleteByToken: () => Effect.void,
} as never);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) =>
    Effect.succeed(
      id === TEST_USER_ID
        ? Option.some({
            id: TEST_USER_ID,
            discord_id: '111111111111111111',
            username: 'rules-user',
            avatar: Option.none(),
            is_profile_complete: true,
            name: Option.none(),
            birth_date: Option.none(),
            gender: Option.none(),
            locale: 'en',
            discord_display_name: Option.none(),
            discord_nickname: Option.none(),
            created_at: now,
            updated_at: now,
          })
        : Option.none(),
    ),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as never);

/** The caller has exactly one active membership — the achievement hook must
 * evaluate it once, per `AchievementEvaluator.evaluate`'s `TeamMemberId` signature. */
const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: () => Effect.die(new Error('Not implemented')),
  findById: () => Effect.succeed(Option.none()),
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  findByUser: () =>
    Effect.succeed([
      {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: true,
        role_names: [],
        permissions: [],
      } as unknown as MembershipWithRole,
    ]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as never);

let insertAttemptCalls: number;
let insertResultsCalls: number;

const RulesAttemptsRepositoryTestLayer = Layer.succeed(RulesAttemptsRepository, {
  _tag: 'api/RulesAttemptsRepository',
  insertAttempt: (
    userId: User.UserId,
    mode: 'practice' | 'exam',
    packages: ReadonlyArray<number>,
    score: number,
    total: number,
  ) => {
    insertAttemptCalls++;
    return Effect.succeed(
      new RulesProgress.RulesAttempt({
        id: 'attempt-1' as RulesProgress.RulesAttemptId,
        user_id: userId,
        mode,
        packages: packages as ReadonlyArray<RulesProgress.Level>,
        started_at: now,
        finished_at: Option.some(now),
        score,
        total,
        created_at: now,
      }),
    );
  },
  insertResults: (_attemptId: unknown, _results: ReadonlyArray<InsertableScenarioResult>) => {
    insertResultsCalls++;
    return Effect.void;
  },
  lastCorrectByScenario: () => Effect.succeed([]),
  lastCorrectByScenarioForTeam: () => Effect.succeed([]),
  getExamStats: () => Effect.succeed({ exams_completed: 0, perfect_exams: 0 }),
} as never);

/** Always dies — the point of these tests is that this must never surface
 * to the caller (`Effect.serviceOption` + `Effect.catchCause`, mirroring
 * `activity-logs.ts`'s achievement hook). */
const FailingAchievementEvaluatorLayer = Layer.succeed(AchievementEvaluator, {
  _tag: 'api/AchievementEvaluator',
  evaluate: () => Effect.die(new Error('boom: achievement evaluation exploded')),
} as never);

// ---------------------------------------------------------------------------
// Minimal single-group API under test
// ---------------------------------------------------------------------------

const TestApi = HttpApi.make('test-api').add(RulesTrainerApi.RulesTrainerApiGroup);

const buildTestLayer = (achievementEvaluatorLayer: Layer.Layer<AchievementEvaluator>) =>
  HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(RulesTrainerApiLive),
    Layer.provide(achievementEvaluatorLayer),
    Layer.provide(RulesAttemptsRepositoryTestLayer),
    Layer.provide(MockTeamMembersRepositoryLayer),
    Layer.provideMerge(HttpServer.layerServices),
  );

// AuthMiddleware needs Sessions + Users; merge those in separately since
// `RulesTrainerApiGroup`'s endpoints all carry `AuthMiddleware`.
const withAuth = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provide(AuthMiddlewareLive),
    Layer.provide(MockSessionsRepositoryLayer),
    Layer.provide(MockUsersRepositoryLayer),
  );

const submitUrl = 'http://localhost/rules/attempts';

const submitRequest = () =>
  new Request(submitUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer member-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'practice', packages: [1], results: [] }),
  });

describe('RulesTrainerApiLive — submitAttempt achievement hook', () => {
  it('achievement evaluation failure does not fail the submit (still returns 201)', async () => {
    insertAttemptCalls = 0;
    insertResultsCalls = 0;

    const layer = withAuth(buildTestLayer(FailingAchievementEvaluatorLayer));
    const app = HttpRouter.toWebHandler(
      layer as unknown as Parameters<typeof HttpRouter.toWebHandler>[0],
    );
    try {
      const response = await app.handler(submitRequest());
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe('attempt-1');
      expect(insertAttemptCalls).toBe(1);
      expect(insertResultsCalls).toBe(1);
    } finally {
      await app.dispose();
    }
  });

  it('succeeds normally when no AchievementEvaluator is provided at all', async () => {
    insertAttemptCalls = 0;
    insertResultsCalls = 0;

    // No AchievementEvaluator layer provided — `Effect.serviceOption` must
    // resolve to `None` and the handler must still succeed.
    const layer = withAuth(
      HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(RulesTrainerApiLive),
        Layer.provide(RulesAttemptsRepositoryTestLayer),
        Layer.provide(MockTeamMembersRepositoryLayer),
        Layer.provideMerge(HttpServer.layerServices),
      ),
    );
    const app = HttpRouter.toWebHandler(
      layer as unknown as Parameters<typeof HttpRouter.toWebHandler>[0],
    );
    try {
      const response = await app.handler(submitRequest());
      expect(response.status).toBe(201);
    } finally {
      await app.dispose();
    }
  });
});
