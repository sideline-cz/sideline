/**
 * `currentAnswer` / `actorTeam` / `stepsOf` / `examScore` — none of these
 * had a dedicated test before this file, despite being exported from the
 * package's `.` entry point.
 */
import { describe, expect, it } from 'vitest';
import { actor, answer, examState, runState, scenario, sid } from './helpers.js';

const { actorTeam, currentAnswer, stepsOf } = await import('~/engine/state.js');
const { examScore } = await import('~/engine/score.js');

describe('currentAnswer', () => {
  it('learn (and any non-exam/review mode): returns the run answer for the current scenario', () => {
    const sc = scenario({ id: sid('cur') });
    const a = answer({ steps: [{ pick: 0, ok: true }] });
    const state = runState({ mode: 'learn', current: sc.id, answers: { [sc.id]: a } });
    expect(currentAnswer(state)).toEqual(a);
  });

  it('learn: returns a blank answer when the current scenario has not been started', () => {
    const state = runState({ mode: 'learn', current: sid('never-started'), answers: {} });
    expect(currentAnswer(state)).toEqual({ steps: [], done: false, ok: false });
  });

  it('exam: always null — the live answer is read off exam.answers[exam.i] by the caller instead', () => {
    const state = runState({
      mode: 'exam',
      exam: examState({ qs: [sid('a')], answers: [answer()], i: 0 }),
    });
    expect(currentAnswer(state)).toBeNull();
  });

  it('review: returns the exam answer at reviewQ', () => {
    const reviewed = answer({ steps: [{ pick: 1, ok: false }], done: true, ok: false });
    const state = runState({
      mode: 'review',
      reviewQ: 1,
      exam: examState({ qs: [sid('a'), sid('b')], answers: [answer(), reviewed], i: 2 }),
    });
    expect(currentAnswer(state)).toEqual(reviewed);
  });

  it('review: null when there is no exam to review', () => {
    const state = runState({ mode: 'review', exam: null });
    expect(currentAnswer(state)).toBeNull();
  });
});

describe('actorTeam', () => {
  it("returns the matching actor's team", () => {
    const sc = scenario({
      actors: [actor({ id: 'O1', team: 'off' }), actor({ id: 'D1', team: 'def' })],
    });
    expect(actorTeam(sc, 'D1')).toBe('def');
    expect(actorTeam(sc, 'O1')).toBe('off');
  });

  it("falls back to 'off' when no actor matches the id", () => {
    const sc = scenario({ actors: [actor({ id: 'O1', team: 'off' })] });
    expect(actorTeam(sc, 'GHOST')).toBe('off');
  });
});

describe('stepsOf', () => {
  it('is just the field accessor for scenario.steps', () => {
    const sc = scenario();
    expect(stepsOf(sc)).toBe(sc.steps);
  });
});

describe('examScore', () => {
  it('counts only ok exam answers', () => {
    const state = runState({
      exam: examState({
        qs: [sid('a'), sid('b'), sid('c')],
        answers: [
          answer({ done: true, ok: true }),
          answer({ done: true, ok: false }),
          answer({ done: true, ok: true }),
        ],
      }),
    });
    expect(examScore(state)).toBe(2);
  });

  it('is 0 when there is no exam', () => {
    expect(examScore(runState({ exam: null }))).toBe(0);
  });
});
