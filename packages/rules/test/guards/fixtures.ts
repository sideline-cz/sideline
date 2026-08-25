/**
 * Minimal, valid fixture builders for the guard "prove it bites" tests.
 *
 * These never touch the real content — each guard test that needs a bad
 * fixture builds one from scratch here and mutates a fresh copy, so a bug in
 * a fixture can never leak into (or be masked by) the real 109 scenarios.
 */
import type {
  Actor,
  Disc,
  Level,
  Localized,
  RulesPackage,
  Scenario,
  ScenarioId,
  Step,
} from '~/types.js';

export const sid = (s: string): ScenarioId => s as ScenarioId;

export const loc = (en: string, cs: string = en): Localized<string> => ({ en, cs });

export function baseActor(overrides: Partial<Actor> = {}): Actor {
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

/** A second actor with no `you` flag — most fixtures want exactly one `you` actor. */
export function baseDefender(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'D1',
    team: 'def',
    label: 'D1',
    kf: [
      [0, 30, 10],
      [5, 25, 15],
    ],
    ...overrides,
  };
}

export function baseDisc(overrides: Partial<Disc> = {}): Disc {
  return {
    kf: [
      [0, 15, 15],
      [5, 22, 18],
    ],
    ...overrides,
  };
}

export function baseStep(overrides: Partial<Step> = {}): Step {
  return {
    k: 'result',
    q: loc('What happens?'),
    rules: ['1.1'],
    opts: [
      { t: loc('Correct'), ok: true, why: loc('because it is correct') },
      { t: loc('Wrong'), why: loc('because it is wrong') },
    ],
    ...overrides,
  };
}

/** A minimal, fully valid scenario — every guard should pass against this by default. */
export function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
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
    actors: [baseActor(), baseDefender()],
    disc: baseDisc(),
    fx: [],
    situation: loc('Fixture situation'),
    question: loc('Fixture question?'),
    explain: loc('Fixture explanation'),
    rules: ['1.1'],
    steps: [baseStep()],
    ...overrides,
  };
}

export function basePackage(level: Level, scenarios: readonly Scenario[]): RulesPackage {
  return { level, name: `Level ${level} · fixture`, scenarios };
}
