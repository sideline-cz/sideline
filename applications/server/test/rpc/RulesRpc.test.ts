/**
 * `Rules/SubmitAttempt` — the Discord bot's write path into the trainer.
 *
 * The bot has no user session, so unlike web it identifies the participant
 * by Discord snowflake and the server resolves it. Everything after that
 * resolution is the SHARED `submitRulesAttempt` pipeline, and these tests
 * exist mainly to hold two things that would otherwise rot quietly:
 *
 *  - a run answered in Discord earns achievements exactly like one answered
 *    on web (the fan-out across ACTIVE memberships, which exists because
 *    `rules_attempts` has no `team_id`)
 *  - a Discord user with no linked account is told so, rather than being
 *    silently told their run saved
 */
import { it as itEffect } from '@effect/vitest';
import type { Discord, RulesProgress, TeamMember, User } from '@sideline/domain';
import { RulesRpcGroup } from '@sideline/domain';
import { ALL_PACKAGES } from '@sideline/rules/content';
import { Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { beforeEach, describe, expect } from 'vitest';
import type { InsertableScenarioResult } from '~/repositories/RulesAttemptsRepository.js';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { RulesRpcLive } from '~/rpc/rules/index.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

const LINKED_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const UNLINKED_DISCORD_ID = '222222222222222222' as Discord.Snowflake;
const USER_ID = '00000000-0000-0000-0000-000000000001' as User.UserId;
const MEMBER_A = '00000000-0000-0000-0000-0000000000a1' as TeamMember.TeamMemberId;
const MEMBER_B = '00000000-0000-0000-0000-0000000000b1' as TeamMember.TeamMemberId;

/** A real scenario, so picks are scored against a real chain rather than a
 * fixture that could drift from the content guards. */
const SCENARIO = ALL_PACKAGES[0]?.scenarios[0];
if (!SCENARIO) throw new Error('content has no scenarios');

const correctPicks = SCENARIO.steps.map((st) => st.opts.findIndex((o) => o.ok === true));

let inserted: Array<{ score: number; total: number; packages: ReadonlyArray<number> }>;
let insertedResults: Array<ReadonlyArray<InsertableScenarioResult>>;
let evaluated: Array<TeamMember.TeamMemberId>;

beforeEach(() => {
  inserted = [];
  insertedResults = [];
  evaluated = [];
});

const usersLayer = (linked: boolean) =>
  Layer.succeed(UsersRepository, {
    findByDiscordId: (discordId: string) =>
      Effect.succeed(
        linked && discordId === LINKED_DISCORD_ID
          ? Option.some({ id: USER_ID } as User.User)
          : Option.none<User.User>(),
      ),
  } as unknown as Effect.Success<ReturnType<typeof UsersRepository.asEffect>>);

const attemptsLayer = Layer.succeed(RulesAttemptsRepository, {
  insertAttempt: (
    _userId: User.UserId,
    _mode: RulesProgress.RulesAttemptMode,
    packages: ReadonlyArray<number>,
    score: number,
    total: number,
  ) => {
    inserted.push({ score, total, packages });
    return Effect.succeed({ id: 'attempt-1', score, total });
  },
  insertResults: (_attemptId: unknown, results: ReadonlyArray<InsertableScenarioResult>) => {
    insertedResults.push(results);
    return Effect.void;
  },
} as unknown as Effect.Success<ReturnType<typeof RulesAttemptsRepository.asEffect>>);

const membersLayer = (memberships: ReadonlyArray<TeamMember.TeamMemberId>) =>
  Layer.succeed(TeamMembersRepository, {
    findByUser: () => Effect.succeed(memberships.map((id) => ({ id }))),
  } as unknown as Effect.Success<ReturnType<typeof TeamMembersRepository.asEffect>>);

const evaluatorLayer = Layer.succeed(AchievementEvaluator, {
  evaluate: (memberId: TeamMember.TeamMemberId) => {
    evaluated.push(memberId);
    return Effect.void;
  },
} as unknown as Effect.Success<ReturnType<typeof AchievementEvaluator.asEffect>>);

const submit = (
  payload: {
    discord_user_id: Discord.Snowflake;
    results: ReadonlyArray<{ scenario_id: string; steps: ReadonlyArray<Option.Option<number>> }>;
  },
  opts: {
    linked?: boolean;
    memberships?: ReadonlyArray<TeamMember.TeamMemberId>;
    withEvaluator?: boolean;
  } = {},
) => {
  const base = RulesRpcLive.pipe(
    Layer.provide(usersLayer(opts.linked ?? true)),
    Layer.provide(attemptsLayer),
    Layer.provide(membersLayer(opts.memberships ?? [])),
  );
  const layer = opts.withEvaluator === true ? base.pipe(Layer.provide(evaluatorLayer)) : base;

  return Effect.scoped(
    // biome-ignore lint/suspicious/noExplicitAny: RpcTest.makeClient is untyped here, as in EmailRpc.test.ts
    (RpcTest.makeClient(RulesRpcGroup.RulesRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        // biome-ignore lint/suspicious/noExplicitAny: see above
        (rpc: any) =>
          rpc['Rules/SubmitAttempt']({
            mode: 'practice',
            packages: [SCENARIO.level],
            ...payload,
            // biome-ignore lint/suspicious/noExplicitAny: see above
          }) as Effect.Effect<any, any, any>,
      ),
    ),
    // biome-ignore lint/suspicious/noExplicitAny: see above
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

const resultFor = (picks: ReadonlyArray<number>) => ({
  scenario_id: SCENARIO.id,
  steps: picks.map((p) => Option.some(p)),
});

describe('Rules/SubmitAttempt', () => {
  itEffect.effect('scores a correct chain server-side and persists it', () =>
    Effect.gen(function* () {
      const saved = yield* submit({
        discord_user_id: LINKED_DISCORD_ID,
        results: [resultFor(correctPicks)],
      });

      expect(saved.score).toBe(1);
      expect(saved.total).toBe(1);
      expect(inserted).toEqual([{ score: 1, total: 1, packages: [SCENARIO.level] }]);
      expect(insertedResults[0]?.[0]?.correct).toBe(true);
    }),
  );

  itEffect.effect('re-scores rather than trusting the submitted picks', () =>
    Effect.gen(function* () {
      // A deliberately wrong pick on the first step must come back as a miss,
      // scored against the real chain rather than anything the caller said.
      const wrong = [...correctPicks];
      const step0 = SCENARIO.steps[0];
      if (!step0) throw new Error('no first step');
      wrong[0] = step0.opts.findIndex((o) => o.ok !== true);

      const saved = yield* submit({
        discord_user_id: LINKED_DISCORD_ID,
        results: [resultFor(wrong)],
      });

      expect(saved.score).toBe(0);
      expect(insertedResults[0]?.[0]?.correct).toBe(false);
    }),
  );

  itEffect.effect('scores an unknown scenario id as incorrect rather than failing', () =>
    Effect.gen(function* () {
      const saved = yield* submit({
        discord_user_id: LINKED_DISCORD_ID,
        results: [{ scenario_id: 'not-a-real-scenario', steps: [Option.some(0)] }],
      });

      expect(saved.score).toBe(0);
      expect(saved.total).toBe(1);
      expect(insertedResults[0]?.[0]?.correct).toBe(false);
    }),
  );

  itEffect.effect('fails with RulesUserNotLinked for an unlinked Discord user', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        submit(
          { discord_user_id: UNLINKED_DISCORD_ID, results: [resultFor(correctPicks)] },
          { linked: false },
        ),
      );

      expect(exit._tag).toBe('Failure');
      // Nothing may be written for a caller we could not resolve.
      expect(inserted).toEqual([]);
    }),
  );

  itEffect.effect('evaluates achievements once per active membership', () =>
    Effect.gen(function* () {
      yield* submit(
        { discord_user_id: LINKED_DISCORD_ID, results: [resultFor(correctPicks)] },
        { memberships: [MEMBER_A, MEMBER_B], withEvaluator: true },
      );

      // The fan-out exists because `rules_attempts` has no `team_id` — a run
      // in Discord must earn milestones in every team the player is in.
      expect(evaluated).toEqual([MEMBER_A, MEMBER_B]);
    }),
  );

  itEffect.effect('still saves when no AchievementEvaluator is available', () =>
    Effect.gen(function* () {
      // The evaluator is read with `Effect.serviceOption`, so its absence
      // must be inert rather than a missing-service defect.
      const saved = yield* submit({
        discord_user_id: LINKED_DISCORD_ID,
        results: [resultFor(correctPicks)],
      });

      expect(saved.score).toBe(1);
      expect(evaluated).toEqual([]);
    }),
  );
});
