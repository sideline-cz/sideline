// Focused tests for the pieces of the exam UI that are cheapest to verify in
// isolation — `examBandKey`'s boundaries (mirroring `app.js:567` exactly) and
// `RulesExamResults`' per-question rendering. The end-to-end exam/review
// flow (spoiler gate, pacing, option-order continuity) is covered in
// `RulesTrainer.test.tsx`, which owns the state these components only render.

import type { ExamState, Scenario, ScenarioId } from '@sideline/rules';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
  setTranslationOverrides: vi.fn(),
}));

const { examBandKey, RulesExamResults } = await import('~/components/organisms/RulesExam.js');

const sid = (s: string): ScenarioId => s as ScenarioId;

describe('examBandKey', () => {
  it('n=10: top at 8, mid at 5, low below that (Math.round(10*0.8)=8, Math.ceil(10/2)=5)', () => {
    expect(examBandKey(10, 10)).toBe('rules_examTop');
    expect(examBandKey(8, 10)).toBe('rules_examTop');
    expect(examBandKey(7, 10)).toBe('rules_examMid');
    expect(examBandKey(5, 10)).toBe('rules_examMid');
    expect(examBandKey(4, 10)).toBe('rules_examLow');
    expect(examBandKey(0, 10)).toBe('rules_examLow');
  });

  it('n=9 (odd): top at 7, mid at 5, low below (round(9*0.8)=7, ceil(9/2)=5)', () => {
    expect(examBandKey(7, 9)).toBe('rules_examTop');
    expect(examBandKey(6, 9)).toBe('rules_examMid');
    expect(examBandKey(5, 9)).toBe('rules_examMid');
    expect(examBandKey(4, 9)).toBe('rules_examLow');
  });

  it('n=0 never divides by zero into a false top', () => {
    expect(examBandKey(0, 0)).toBe('rules_examLow');
  });
});

function fixtureScenario(id: string, title: string): Scenario {
  return {
    id: sid(id),
    level: 1,
    topic: { en: 'Topic', cs: 'Topic' },
    title: { en: title, cs: title },
    roleTeam: 'off',
    role: { en: 'Thrower', cs: 'Thrower' },
    view: [0, 0, 100, 37],
    dur: 10,
    qAt: 4,
    actors: [],
    disc: {
      kf: [
        [0, 0, 0],
        [10, 0, 0],
      ],
    },
    fx: [],
    situation: { en: 'Situation', cs: 'Situation' },
    question: { en: 'Question?', cs: 'Question?' },
    explain: { en: 'Explain', cs: 'Explain' },
    rules: [],
    steps: [
      {
        k: 'what',
        q: { en: 'Step1?', cs: 'Step1?' },
        rules: [],
        opts: [{ t: { en: 'Right', cs: 'Right' }, ok: true, why: { en: 'why', cs: 'why' } }],
      },
    ],
  };
}

describe('RulesExamResults', () => {
  it('lists every question with its own tally and opens review on click', () => {
    const scA = fixtureScenario('a', 'Scenario A');
    const scB = fixtureScenario('b', 'Scenario B');
    const scenariosById = new Map([
      [scA.id, scA],
      [scB.id, scB],
    ]);
    const examState: ExamState = {
      qs: [scA.id, scB.id],
      perms: [[[0]], [[0]]],
      answers: [
        { steps: [{ pick: 0, ok: true }], done: true, ok: true },
        { steps: [{ pick: 0, ok: false }], done: true, ok: false },
      ],
      i: 2,
    };
    const onReview = vi.fn();

    render(
      <RulesExamResults
        locale='en'
        examState={examState}
        score={1}
        scenariosById={scenariosById}
        onReview={onReview}
        onExamAgain={() => {}}
        onToPractice={() => {}}
      />,
    );

    expect(screen.getByText('Scenario A')).not.toBeNull();
    expect(screen.getByText('Scenario B')).not.toBeNull();
    // The score is split across two spans so the achieved half can carry the
    // band colour and the total stays muted — match on the whole readout.
    expect(
      screen.getByText((_, el) => el?.textContent === '1 / 2' && el.tagName === 'DIV'),
    ).not.toBeNull();

    fireEvent.click(screen.getByText('Scenario B'));
    expect(onReview).toHaveBeenCalledWith(1);
  });
});
