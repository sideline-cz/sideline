/**
 * The one submit-an-attempt pipeline, shared by the HTTP handler
 * (`api/rules-trainer.ts`, called by web) and the RPC handler
 * (`rpc/rules/index.ts`, called by the Discord bot).
 *
 * **Extracted rather than duplicated on purpose.** The pipeline is four
 * steps — score, insert the attempt, insert its results, fan achievements
 * out across active memberships — and only the *last* is easy to get subtly
 * wrong twice. `rules_attempts` has no `team_id` (a deliberate decision, so
 * progress survives joining and leaving a team), so evaluation has to
 * resolve the caller's ACTIVE memberships at submit time and evaluate once
 * per team. A second copy of that in the RPC layer would be the obvious
 * place for Discord practice to silently stop earning achievements.
 *
 * Callers differ only in how they establish `userId`: HTTP reads it from the
 * authenticated session, RPC resolves it from a Discord snowflake.
 */
import type { RulesTrainerApi, User } from '@sideline/domain';
import type { Scenario } from '@sideline/rules';
import { scoreAttempt } from '@sideline/rules';
import { ALL_PACKAGES } from '@sideline/rules/content';
import { Effect, Option } from 'effect';
import type { InsertableScenarioResult } from '~/repositories/RulesAttemptsRepository.js';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

/**
 * `@sideline/rules/content` is an eager import of all nine packages — fine
 * on the server (see `packages/rules/AGENTS.md`'s "the one web must never
 * use"). Built once at module load, not per request.
 *
 * Keyed by plain `string`, not `ScenarioId` — `ScenarioId` is a bare TS
 * brand with no `Schema` and no smart constructor, so a wire-decoded
 * `scenario_id: string` looks up directly without a cast.
 */
const scenarioById = new Map<string, Scenario>(
  ALL_PACKAGES.flatMap((pkg) => pkg.scenarios.map((scenario) => [scenario.id, scenario] as const)),
);

/**
 * Scores every submitted scenario against its real chain. `scoreAttempt`
 * (`@sideline/rules`) is pure — this is the call site that lifts its result
 * into `Effect`, per `packages/domain/AGENTS.md`.
 *
 * An unknown `scenario_id` (stale client content, a typo, a scenario removed
 * since the client last synced) is scored as incorrect with no steps rather
 * than failing the request — `scoreAttempt` needs a real chain to score
 * against, and `packageMastery` ignores outcomes outside a package's roster
 * anyway, so a junk id is inert at read time.
 */
export const scoreSubmittedResults = (
  results: ReadonlyArray<RulesTrainerApi.SubmitAttemptResultInput>,
): Effect.Effect<{
  readonly scored: ReadonlyArray<InsertableScenarioResult>;
  readonly score: number;
  readonly total: number;
}> =>
  Effect.sync(() => {
    const scored = results.map((result): InsertableScenarioResult => {
      const scenario = scenarioById.get(result.scenario_id);
      if (scenario === undefined) {
        return { scenario_id: result.scenario_id, correct: false, steps: [] };
      }
      const picks = result.steps.map((pick) => Option.getOrElse(pick, () => -1));
      const answer = scoreAttempt(scenario.steps, picks);
      return { scenario_id: result.scenario_id, correct: answer.ok, steps: answer.steps };
    });
    return {
      scored,
      score: scored.filter((r) => r.correct).length,
      total: scored.length,
    };
  });

/** Structurally the wire request minus the caller — deliberately derived
 * from `SubmitAttemptRequest` rather than restated, so the HTTP payload can
 * be passed straight through and the RPC payload has one shape to match. */
export interface SubmitAttemptInput {
  readonly mode: RulesTrainerApi.SubmitAttemptRequest['mode'];
  readonly packages: RulesTrainerApi.SubmitAttemptRequest['packages'];
  readonly results: RulesTrainerApi.SubmitAttemptRequest['results'];
}

/**
 * Score, persist, and fan achievements out for one attempt by `userId`.
 *
 * Achievement evaluation is **best effort and must never fail the submit** —
 * a practice run that scored fine but whose milestone evaluation errored
 * still has to be recorded. Mirrors `activity-logs.ts`'s hook shape.
 *
 * `AchievementEvaluator` is read with `Effect.serviceOption`, so it stays
 * absent-tolerant and adds nothing to this effect's requirements — which is
 * what keeps this callable from both the HTTP and RPC layers without
 * touching the 41-file mock cascade.
 */
export const submitRulesAttempt = (userId: User.UserId, input: SubmitAttemptInput) =>
  Effect.Do.pipe(
    Effect.bind('rulesAttempts', () => RulesAttemptsRepository.asEffect()),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('evaluatorOpt', () => Effect.serviceOption(AchievementEvaluator)),
    Effect.bind('scoring', () => scoreSubmittedResults(input.results)),
    Effect.bind('attempt', ({ rulesAttempts, scoring }) =>
      rulesAttempts.insertAttempt(userId, input.mode, input.packages, scoring.score, scoring.total),
    ),
    Effect.tap(({ rulesAttempts, attempt, scoring }) =>
      rulesAttempts.insertResults(attempt.id, scoring.scored),
    ),
    Effect.tap(({ members, evaluatorOpt }) =>
      Option.match(evaluatorOpt, {
        onNone: () => Effect.void,
        onSome: (evaluator) =>
          members.findByUser(userId).pipe(
            Effect.flatMap((memberships) =>
              Effect.forEach(memberships, (membership) => evaluator.evaluate(membership.id), {
                concurrency: 1,
              }),
            ),
            Effect.asVoid,
            Effect.catchCause((cause) => Effect.logWarning('Achievement evaluation failed', cause)),
          ),
      }),
    ),
    Effect.map(({ attempt }) => attempt),
  );
