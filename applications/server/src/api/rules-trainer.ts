import { Auth, RulesProgress, type RulesTrainerApi } from '@sideline/domain';
import type { Scenario } from '@sideline/rules';
import { overallMastery, packageMastery, scoreAttempt } from '@sideline/rules';
import { ALL_PACKAGES } from '@sideline/rules/content';
import { type DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import type { InsertableScenarioResult } from '~/repositories/RulesAttemptsRepository.js';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';

/**
 * `@sideline/rules/content` is an eager import of all nine packages — fine
 * here (server, not `applications/web`; see `packages/rules/AGENTS.md`'s
 * "the one web must never use"). Built once at module load, not per request:
 * a scenario lookup by id, and the full per-level scenario roster `myProgress`
 * needs so unanswered scenarios still count as `0` (see `engine/mastery.ts`'s
 * `packageMastery` doc — passing only touched scenarios would make mastery
 * trivially reachable).
 *
 * Keyed by plain `string`, not `ScenarioId` — `ScenarioId` is a bare TS brand
 * with no `Schema` and no smart constructor (see `RulesProgress.ts`'s module
 * doc), so a wire-decoded `scenario_id: string` can look it up directly
 * without a cast.
 */
const scenarioById = new Map<string, Scenario>(
  ALL_PACKAGES.flatMap((pkg) => pkg.scenarios.map((scenario) => [scenario.id, scenario] as const)),
);

/**
 * Scores every submitted scenario against its real chain. `scoreAttempt`
 * (`@sideline/rules`) is pure — this is the call site that lifts its result
 * into `Effect`, per `packages/domain/AGENTS.md` ("never wrap a pure
 * function's result in Effect inside the pure module itself").
 *
 * An unknown `scenario_id` (stale client content, a typo, a scenario removed
 * since the client last synced) is scored as incorrect with no steps rather
 * than failing the request — `scoreAttempt` needs a real chain to score
 * against, and `packageMastery` ignores outcomes outside a package's roster
 * anyway, so a junk id is inert at read time (see `RulesTrainerApi.ts`'s
 * module doc).
 */
const scoreSubmittedResults = (
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

/**
 * Maps the decayed-mastery computation (`@sideline/rules`'s
 * `engine/mastery.ts`) onto the `RulesMasterySummary` wire DTO. Every package
 * is derived from its FULL scenario roster (`ALL_PACKAGES`), not just the
 * scenarios present in `rows` — an unanswered scenario must still count as
 * `0`, never be silently absent from the mean.
 */
const buildMasterySummary = (
  rows: ReadonlyArray<{ readonly scenario_id: string; readonly last_correct_at: DateTime.Utc }>,
): RulesProgress.RulesMasterySummary => {
  const lastCorrectAtByScenario = new Map(
    rows.map((row) => [row.scenario_id, row.last_correct_at.epochMilliseconds] as const),
  );
  const now = Date.now();

  const masteries = ALL_PACKAGES.map((pkg) => {
    const scenarioIds = pkg.scenarios.map((scenario) => scenario.id);
    const outcomes = scenarioIds.map((scenarioId) => ({
      scenarioId,
      lastCorrectAt: lastCorrectAtByScenario.get(scenarioId) ?? null,
    }));
    return packageMastery(pkg.level, scenarioIds, outcomes, now);
  });

  const overall = overallMastery(masteries);

  return new RulesProgress.RulesMasterySummary({
    packages: masteries.map(
      (m) =>
        new RulesProgress.RulesPackageMastery({
          level: m.level,
          strength: m.strength,
          mastered: m.mastered,
          freshCount: m.freshCount,
          everCorrectCount: m.everCorrectCount,
          total: m.total,
        }),
    ),
    overall: new RulesProgress.RulesOverallMastery({
      strength: overall.strength,
      masteredCount: overall.masteredCount,
      totalScenarios: overall.totalScenarios,
    }),
  });
};

export const RulesTrainerApiLive = HttpApiBuilder.group(Api, 'rulesTrainer', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('rulesAttempts', () => RulesAttemptsRepository.asEffect()),
    Effect.map(({ rulesAttempts }) =>
      handlers
        .handle('submitAttempt', ({ payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('scoring', () => scoreSubmittedResults(payload.results)),
            Effect.bind('attempt', ({ currentUser, scoring }) =>
              rulesAttempts.insertAttempt(
                currentUser.id,
                payload.mode,
                payload.packages,
                scoring.score,
                scoring.total,
              ),
            ),
            Effect.tap(({ attempt, scoring }) =>
              rulesAttempts.insertResults(attempt.id, scoring.scored),
            ),
            Effect.map(({ attempt }) => attempt),
          ),
        )
        .handle('myProgress', () =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('rows', ({ currentUser }) =>
              rulesAttempts.lastCorrectByScenario(currentUser.id),
            ),
            Effect.map(({ rows }) => buildMasterySummary(rows)),
          ),
        ),
    ),
  ),
);
