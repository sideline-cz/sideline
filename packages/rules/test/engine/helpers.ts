/**
 * Shared engine-test helpers: a deterministic RNG stub (no seeded-PRNG
 * dependency is added to the package itself — this lives only in tests) and
 * minimal scenario/package builders that every `test/engine/*.test.ts` file
 * builds its fixtures from.
 *
 * `Answer` / `RunState` / `ExamState` / `Mode` / `StepPick` are `import
 * type`-only purely as good practice (this file has no runtime dependency
 * on `~/engine/state.js`, only on the shapes it declares).
 */
import type { Answer, ExamState, Mode, RunState, StepPick } from '~/engine/state.js';
import type {
  Actor,
  Disc,
  Keyframe,
  Level,
  Localized,
  RulesPackage,
  Scenario,
  ScenarioId,
  Step,
} from '~/types.js';

/** A tiny deterministic LCG so exam/perms tests can assert reproducibility without `Math.random`. */
export function makeRng(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 48271) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

export const sid = (s: string): ScenarioId => s as ScenarioId;

export const loc = (en: string, cs: string = en): Localized<string> => ({ en, cs });

export function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'O1',
    team: 'off',
    label: 'O1',
    you: true,
    kf: [
      [0, 10, 10],
      [5, 20, 20],
    ],
    ...overrides,
  };
}

export function disc(overrides: Partial<Disc> = {}): Disc {
  return {
    kf: [
      [0, 15, 15],
      [5, 22, 18],
    ],
    ...overrides,
  };
}

export function step(overrides: Partial<Step> = {}): Step {
  return {
    k: 'result',
    q: loc('What happens?'),
    rules: [],
    opts: [
      { t: loc('Correct'), ok: true, why: loc('because') },
      { t: loc('Wrong'), why: loc('nope') },
    ],
    ...overrides,
  };
}

export function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: sid('fix1'),
    level: 1,
    topic: loc('Fixture topic'),
    title: loc('Fixture title'),
    roleTeam: 'off',
    role: loc('fixture role'),
    view: [0, 0, 100, 37],
    dur: 5,
    qAt: 3,
    actors: [actor(), actor({ id: 'D1', team: 'def', label: 'D1' })].map(
      ({ you: _you, ...rest }, i) => (i === 0 ? { ...rest, you: true as const } : rest),
    ),
    disc: disc(),
    fx: [],
    situation: loc('Fixture situation'),
    question: loc('Fixture question?'),
    explain: loc('Fixture explanation'),
    rules: [],
    steps: [step()],
    ...overrides,
  };
}

export function pkg(level: Level, scenarios: readonly Scenario[]): RulesPackage {
  return { level, name: `Level ${level} · fixture`, scenarios };
}

export const kf = (t: number, x: number, y: number): Keyframe => [t, x, y];

export function blankAnswer(): Answer {
  return { steps: [], done: false, ok: false };
}

export function answer(overrides: Partial<Answer> = {}): Answer {
  return { ...blankAnswer(), ...overrides };
}

export const stepPick = (pick: number, ok: boolean): StepPick => ({ pick, ok });

export function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    lang: 'en',
    mode: 'learn' as Mode,
    current: sid('fix1'),
    sel: [1],
    answers: {},
    perms: {},
    exam: null,
    reviewQ: 0,
    ...overrides,
  };
}

export function examState(overrides: Partial<ExamState> = {}): ExamState {
  return {
    qs: [],
    perms: [],
    answers: [],
    i: 0,
    ...overrides,
  };
}

/**
 * Deep-freezes an object graph so tests can assert the engine never mutates
 * frozen content — the source app mutated `kf.mx` / `kf.my` onto the
 * imported keyframe array (`app.js:71`), which this port must not do (see
 * the Phase 0 plan, decision D3).
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
