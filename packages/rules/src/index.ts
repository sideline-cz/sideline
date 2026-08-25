/**
 * `@sideline/rules` — the `.` entry point.
 *
 * Types, constants and lazy `PACKAGE_LOADERS` only. Must never import
 * `content.ts` (or any package JSON) — that eager import belongs solely to
 * the `@sideline/rules/content` subpath, so this entry point stays cheap for
 * the server, the bot, and (once the engine lands) `applications/web`. See
 * `packages/rules/AGENTS.md`.
 */

export type { LevelMeta } from './constants.js';

export { EXAM_N, LEVEL_META, LEVELS } from './constants.js';
export { PACKAGE_LOADERS } from './content/loaders.js';
export type { Animator } from './engine/anim.js';
export { animLimit, createAnimator, ipos, pathTangents } from './engine/anim.js';
export { advanceExam, answerStep, examAnswer, openReview } from './engine/answer.js';
export type { ChainEntry, ChainStepState } from './engine/chain.js';
export { chainView } from './engine/chain.js';
export { startExam } from './engine/exam.js';
export { text } from './engine/locale.js';
export type { PackageMastery, ScenarioOutcome } from './engine/mastery.js';
export {
  MASTERED_THRESHOLD,
  MASTERY_HALF_LIFE_DAYS,
  overallMastery,
  packageMastery,
  scenarioStrength,
} from './engine/mastery.js';
export { buildPerms, buildRunPerms, shuffle } from './engine/perms.js';
export { countLevel, pool, poolLen, posOf } from './engine/pool.js';
export { answeredCount, examScore, score, scoreAttempt } from './engine/score.js';
export type { Answer, ExamState, Mode, RunState, StepPick } from './engine/state.js';
export { actorTeam, blankAnswer, currentAnswer, stepsOf } from './engine/state.js';
export type {
  Actor,
  Disc,
  Fx,
  FxArrow,
  FxBubble,
  FxBubbleStyle,
  FxFlash,
  FxMark,
  FxMarkKind,
  Keyframe,
  Lang,
  Level,
  Localized,
  Option,
  RuleEntry,
  RulesPackage,
  Scenario,
  ScenarioId,
  SignalEntry,
  Step,
  Team,
} from './types.js';
