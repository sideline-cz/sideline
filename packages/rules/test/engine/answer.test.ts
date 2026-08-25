/**
 * `answerStep` / `examAnswer` / `advanceExam` — the chain-advancing pure
 * transitions (Phase 0 plan, "Engine port": `engine/answer.ts`). All four
 * guards from the source (`a.done`, empty chain, `!st`, `!st.opts[pick]`)
 * must still hold, and — unlike the source, which mutated `state.answers[i]`
 * in place — none of these may mutate their input state.
 */
import { describe, expect, it } from 'vitest';
import { answer, examState, runState, scenario, sid, step } from './helpers.js';

const { advanceExam, answerStep, examAnswer, openReview } = await import('~/engine/answer.js');

describe('answerStep', () => {
  const twoStepScenario = scenario({
    id: sid('two'),
    steps: [
      step({
        k: 'a',
        opts: [
          { t: { en: 'right', cs: 'right' }, ok: true, why: { en: '', cs: '' } },
          { t: { en: 'wrong', cs: 'wrong' }, why: { en: '', cs: '' } },
        ],
      }),
      step({
        k: 'b',
        opts: [
          { t: { en: 'right', cs: 'right' }, ok: true, why: { en: '', cs: '' } },
          { t: { en: 'wrong', cs: 'wrong' }, why: { en: '', cs: '' } },
        ],
      }),
    ],
  });

  it('appends exactly one StepPick', () => {
    const state = runState({ current: twoStepScenario.id });
    const next = answerStep(state, twoStepScenario, 0);
    expect(next.answers[twoStepScenario.id]?.steps).toEqual([{ pick: 0, ok: true }]);
  });

  it('done is true only once every step of the chain is answered', () => {
    const state = runState({ current: twoStepScenario.id });
    const afterOne = answerStep(state, twoStepScenario, 0);
    expect(afterOne.answers[twoStepScenario.id]?.done).toBe(false);
    const afterTwo = answerStep(afterOne, twoStepScenario, 0);
    expect(afterTwo.answers[twoStepScenario.id]?.done).toBe(true);
  });

  it('ok is true only when every step was ok', () => {
    const state = runState({ current: twoStepScenario.id });
    const wrongThenRight = answerStep(answerStep(state, twoStepScenario, 1), twoStepScenario, 0);
    expect(wrongThenRight.answers[twoStepScenario.id]?.done).toBe(true);
    expect(wrongThenRight.answers[twoStepScenario.id]?.ok).toBe(false);

    const rightThenRight = answerStep(answerStep(state, twoStepScenario, 0), twoStepScenario, 0);
    expect(rightThenRight.answers[twoStepScenario.id]?.ok).toBe(true);
  });

  it('ignores a pick once the chain is done', () => {
    const state = runState({ current: twoStepScenario.id });
    const done = answerStep(answerStep(state, twoStepScenario, 0), twoStepScenario, 0);
    const again = answerStep(done, twoStepScenario, 1);
    expect(again.answers[twoStepScenario.id]).toEqual(done.answers[twoStepScenario.id]);
  });

  it.each([-1, 2, 1.5, Number.NaN])('ignores an invalid pick (%p)', (badPick) => {
    const state = runState({ current: twoStepScenario.id });
    const next = answerStep(state, twoStepScenario, badPick);
    expect(next.answers[twoStepScenario.id]?.steps ?? []).toHaveLength(0);
  });

  it('ignores any pick on a scenario with an empty chain', () => {
    const empty = scenario({ id: sid('empty'), steps: [] });
    const state = runState({ current: empty.id });
    const next = answerStep(state, empty, 0);
    expect(next.answers[empty.id]?.steps ?? []).toHaveLength(0);
  });

  it('does not mutate the input state', () => {
    const state = runState({ current: twoStepScenario.id });
    const pristine = structuredClone(state);
    answerStep(state, twoStepScenario, 0);
    expect(state).toEqual(pristine);
  });
});

describe('examAnswer / advanceExam', () => {
  const singleStepScenario = scenario({
    id: sid('exq1'),
    steps: [
      step({
        opts: [
          { t: { en: 'right', cs: 'right' }, ok: true, why: { en: '', cs: '' } },
          { t: { en: 'wrong', cs: 'wrong' }, why: { en: '', cs: '' } },
        ],
      }),
    ],
  });
  const otherScenario = scenario({ id: sid('exq2'), steps: [step()] });

  it('examAnswer appends a pick to the current exam question', () => {
    const state = runState({
      mode: 'exam',
      exam: examState({
        qs: [singleStepScenario.id, otherScenario.id],
        answers: [answer(), answer()],
      }),
    });
    const next = examAnswer(state, singleStepScenario, 0);
    expect(next.exam?.answers[0]).toEqual({ steps: [{ pick: 0, ok: true }], done: true, ok: true });
  });

  it('examAnswer does not mutate the input state', () => {
    const state = runState({
      mode: 'exam',
      exam: examState({
        qs: [singleStepScenario.id, otherScenario.id],
        answers: [answer(), answer()],
      }),
    });
    const pristine = structuredClone(state);
    examAnswer(state, singleStepScenario, 0);
    expect(state).toEqual(pristine);
  });

  it('advanceExam increments i and stays in exam mode while more questions remain', () => {
    const state = runState({
      mode: 'exam',
      exam: examState({
        qs: [singleStepScenario.id, otherScenario.id],
        answers: [answer(), answer()],
        i: 0,
      }),
    });
    const next = advanceExam(state);
    expect(next.exam?.i).toBe(1);
    expect(next.mode).toBe('exam');
  });

  it('advanceExam switches to examResults once i reaches qs.length', () => {
    const state = runState({
      mode: 'exam',
      exam: examState({
        qs: [singleStepScenario.id, otherScenario.id],
        answers: [answer(), answer()],
        i: 1,
      }),
    });
    const next = advanceExam(state);
    expect(next.exam?.i).toBe(2);
    expect(next.mode).toBe('examResults');
  });
});

describe('openReview', () => {
  const sc1 = sid('r1');
  const sc2 = sid('r2');

  it('switches to review mode, sets reviewQ and current to the requested question', () => {
    const state = runState({
      mode: 'examResults',
      exam: examState({ qs: [sc1, sc2], answers: [answer(), answer()] }),
    });
    const next = openReview(state, 1);
    expect(next.mode).toBe('review');
    expect(next.reviewQ).toBe(1);
    expect(next.current).toBe(sc2);
  });

  it('is a no-op when there is no exam to review', () => {
    const state = runState({ mode: 'examResults', exam: null });
    const next = openReview(state, 0);
    expect(next).toEqual(state);
  });

  it('is a no-op for an out-of-range question index', () => {
    const state = runState({
      mode: 'examResults',
      exam: examState({ qs: [sc1], answers: [answer()] }),
    });
    const next = openReview(state, 5);
    expect(next).toEqual(state);
  });
});
