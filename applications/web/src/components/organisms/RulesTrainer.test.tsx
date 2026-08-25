// Tests for RulesTrainer — the practice flow's spoiler gate (see
// `docs/plans/rules-trainer.md`): a locked step must never leak its key
// label, options must render in the run's permutation (`order`), a click
// must report the ORIGINAL option index (not its display position), and the
// demo must never play past `animLimit` before the chain is answered.

import type { RulesPackage, Scenario, ScenarioId } from '@sideline/rules';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  // Returning the raw key (mirroring `tr()`'s own unknown-key fallback)
  // keeps assertions readable without maintaining a full copy map here.
  tr: (key: string) => key,
  setTranslationOverrides: vi.fn(),
}));

// No runtime constructor exists for `ScenarioId` (see `packages/rules`'s
// `types.ts`) — mirrors `packages/rules/test/engine/helpers.ts`'s `sid`.
const sid = (s: string): ScenarioId => s as ScenarioId;

const FIXTURE_SCENARIO: Scenario = {
  id: sid('fix1'),
  level: 1,
  topic: { en: 'Fixture topic', cs: 'Fixture topic' },
  title: { en: 'Fixture title', cs: 'Fixture title' },
  roleTeam: 'off',
  role: { en: 'Thrower', cs: 'Thrower' },
  view: [0, 0, 100, 37],
  dur: 10,
  qAt: 4,
  actors: [
    {
      id: 'O1',
      team: 'off',
      label: 'O1',
      you: true,
      kf: [
        [0, 10, 10],
        [10, 30, 30],
      ],
    },
  ],
  disc: {
    kf: [
      [0, 15, 15],
      [10, 35, 35],
    ],
  },
  fx: [],
  situation: { en: 'Fixture situation', cs: 'Fixture situation' },
  question: { en: 'Fixture question?', cs: 'Fixture question?' },
  explain: { en: 'Fixture explanation', cs: 'Fixture explanation' },
  rules: [],
  steps: [
    {
      k: 'what',
      q: { en: 'Step1?', cs: 'Step1?' },
      rules: [],
      opts: [
        { t: { en: 'Wrong0', cs: 'Wrong0' }, why: { en: 'why0', cs: 'why0' } },
        { t: { en: 'Right1', cs: 'Right1' }, ok: true, why: { en: 'why1', cs: 'why1' } },
      ],
    },
    {
      k: 'where',
      q: { en: 'Step2?', cs: 'Step2?' },
      rules: [],
      opts: [
        { t: { en: 'Right0', cs: 'Right0' }, ok: true, why: { en: 'why0', cs: 'why0' } },
        { t: { en: 'Wrong1', cs: 'Wrong1' }, why: { en: 'why1', cs: 'why1' } },
      ],
    },
  ],
};

const FIXTURE_PACKAGE: RulesPackage = {
  level: 1,
  name: 'Fixture package',
  scenarios: [FIXTURE_SCENARIO],
};

// A second, single-step level — exists solely so the exam tests can select
// two packages and assert both are representable (`startExam`'s own
// per-level stratification is tested in `packages/rules`; this only checks
// that the web wiring passes `scenarios`/`sel` through correctly).
const FIXTURE_SCENARIO_2: Scenario = {
  id: sid('fix2'),
  level: 2,
  topic: { en: 'Fixture topic 2', cs: 'Fixture topic 2' },
  title: { en: 'Fixture title 2', cs: 'Fixture title 2' },
  roleTeam: 'off',
  role: { en: 'Marker', cs: 'Marker' },
  view: [0, 0, 100, 37],
  dur: 6,
  qAt: 2,
  actors: [],
  disc: {
    kf: [
      [0, 5, 5],
      [6, 20, 20],
    ],
  },
  fx: [],
  situation: { en: 'Fixture situation 2', cs: 'Fixture situation 2' },
  question: { en: 'Fixture question 2?', cs: 'Fixture question 2?' },
  explain: { en: 'Fixture explanation 2', cs: 'Fixture explanation 2' },
  rules: [],
  steps: [
    {
      k: 'what',
      q: { en: 'OnlyStep?', cs: 'OnlyStep?' },
      rules: [],
      opts: [{ t: { en: 'OnlyOption', cs: 'OnlyOption' }, ok: true, why: { en: 'w', cs: 'w' } }],
    },
  ],
};

const FIXTURE_PACKAGE_2: RulesPackage = {
  level: 2,
  name: 'Fixture package 2',
  scenarios: [FIXTURE_SCENARIO_2],
};

vi.mock('@sideline/rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sideline/rules')>();
  return {
    ...actual,
    LEVELS: [1, 2],
    LEVEL_META: {
      1: { level: 1, name: { en: 'Fixture package', cs: 'Fixture package' }, scenarioCount: 1 },
      2: { level: 2, name: { en: 'Fixture package 2', cs: 'Fixture package 2' }, scenarioCount: 1 },
    },
  };
});

const FIXTURE_CHEAT_SHEET = {
  cheatStallH: { en: ['a', 'b'], cs: ['a', 'b'] },
  cheatStallRows: { en: [['1', '2']], cs: [['1', '2']] },
  cheatWhoRows: { en: [['x', 'y']], cs: [['x', 'y']] },
  cheatGoldRows: { en: [['p', 'q']], cs: [['p', 'q']] },
};

vi.mock('@sideline/rules/reference', () => ({
  RULES: {},
  SIGNALS: {},
  CHEAT_SHEET: FIXTURE_CHEAT_SHEET,
}));

// The organism loads content through the web-local map, not the package's
// own PACKAGE_LOADERS — see `~/lib/rules/loaders.ts`.
vi.mock('~/lib/rules/loaders.js', () => ({
  WEB_PACKAGE_LOADERS: {
    1: () => Promise.resolve(FIXTURE_PACKAGE),
    2: () => Promise.resolve(FIXTURE_PACKAGE_2),
  },
}));

const { RulesTrainer } = await import('~/components/organisms/RulesTrainer.js');
const { ipos } = await import('@sideline/rules');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Registers with `requestAnimationFrame` but never auto-schedules — tests
 * drive frames manually via the returned `tick()` so the animation is fully
 * deterministic (no reliance on real timers/frames). */
function stubAnimationFrame() {
  let latestTick: ((now: number) => void) | null = null;
  const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    latestTick = cb;
    return 0;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  return {
    tick: (now: number) => {
      const cb = latestTick;
      expect(cb).not.toBeNull();
      act(() => cb?.(now));
    },
    restore: () => rafSpy.mockRestore(),
  };
}

function discGroup(): Element {
  const svg = document.querySelector('svg[role="img"]');
  expect(svg).not.toBeNull();
  const group = Array.from(svg?.querySelectorAll('g') ?? []).find((g) =>
    g.querySelector('circle[r="0.78"]'),
  );
  expect(group).not.toBeUndefined();
  if (!group) throw new Error('disc group not found');
  return group;
}

/** Deselects level 2 (the default selection is both fixture levels), so a
 * run only ever covers `FIXTURE_SCENARIO` — every pre-existing assertion in
 * this file about "step 1"/"step 2" was written against that one scenario,
 * before the exam tests added a second level. */
async function selectOnlyLevel1() {
  fireEvent.click(await screen.findByRole('button', { name: /rules_level_2_name/ }));
}

async function startPractice() {
  render(<RulesTrainer locale='en' />);
  await selectOnlyLevel1();
  // Anchored + `\b` so this never also matches the "🎓 rules_startExam (…)"
  // button the exam entry point added alongside it.
  fireEvent.click(await screen.findByRole('button', { name: /^rules_start\b/ }));
  // Practice screen renders once the (mocked) package promise resolves.
  await screen.findByText('Step1?');
}

/** Starts a single-question exam (level 1 only, so it is always
 * `FIXTURE_SCENARIO`) and waits for the first (only) step to render. */
async function startExamFlow() {
  render(<RulesTrainer locale='en' />);
  await selectOnlyLevel1();
  fireEvent.click(await screen.findByRole('button', { name: /🎓 rules_startExam/ }));
  await screen.findByText('Step1?');
}

/** Every button on the exam question screen other than the play/slow
 * transport controls is a live option button for the currently-visible
 * step — exam mode never shows more than one step at a time, so this is
 * always exactly that step's option(s). */
function currentExamOptionButtons(): HTMLElement[] {
  return screen
    .getAllByRole('button')
    .filter((b) => !/^(rules_play|rules_replay|rules_slow)$/.test(b.textContent ?? ''));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('RulesTrainer', () => {
  it('renders the correct option first, in reversed order, and reports the ORIGINAL index on click', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    await startPractice();

    // With `Math.random` stubbed to 0, a 2-option Fisher-Yates shuffle
    // always swaps — display order becomes [1, 0] for every 2-option step.
    const buttons = screen.getAllByRole('button', { name: /Wrong0|Right1/ });
    expect(buttons[0].textContent).toContain('Right1');
    expect(buttons[1].textContent).toContain('Wrong0');

    // Clicking the correct-but-display-first option must resolve as
    // correct — if the click handler passed the DISPLAY position (0)
    // instead of the ORIGINAL index (1), this would score as wrong.
    fireEvent.click(buttons[0]);
    await screen.findByText('Step2?');
    // Step 1 stays visible (answered), but its options are now disabled.
    for (const button of screen.getAllByRole('button', { name: /Wrong0|Right1/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    randomSpy.mockRestore();
  });

  it('does not reshuffle a step’s options when a later step is answered', async () => {
    // `buildRunPerms` is called once, inside an effect guarded on
    // `screen !== 'loadingPractice'` — but that effect's deps include
    // `answers`, so it re-runs on every answered step. Only the guard stops
    // it rebuilding the permutation mid-run, which would visibly reorder
    // options under the user and is exactly what `perms` exists to prevent
    // (see `packages/rules/src/engine/perms.ts`). Nothing else pins this, so
    // a refactor that loosens the guard would otherwise pass silently.
    // A CONSTANT `Math.random` would make this test vacuous: `buildRunPerms`
    // would produce an identical permutation on a rebuild, so a reshuffle
    // would be undetectable. (Verified — the first version of this test
    // passed with a rebuild deliberately injected.) So the stub must yield a
    // DIFFERENT permutation on the second build: the fixture has two 2-option
    // steps, so calls 1-2 are the first build and 3+ any rebuild. For a
    // 2-element Fisher-Yates, < 0.5 swaps and >= 0.5 does not.
    let call = 0;
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => (++call <= 2 ? 0 : 0.9));
    await startPractice();

    const orderBefore = screen
      .getAllByRole('button', { name: /Wrong0|Right1/ })
      .map((b) => b.textContent);
    expect(orderBefore[0]).toContain('Right1'); // first build swapped

    // Answer step 1, which changes `answers` and re-runs the loader effect.
    fireEvent.click(screen.getAllByRole('button', { name: /Wrong0|Right1/ })[0]);
    await screen.findByText('Step2?');

    const orderAfter = screen
      .getAllByRole('button', { name: /Wrong0|Right1/ })
      .map((b) => b.textContent);
    expect(orderAfter).toEqual(orderBefore);

    randomSpy.mockRestore();
  });

  it('never shows a locked step’s key label before it is reached', async () => {
    await startPractice();

    // Step 2 ("where") is locked until step 1 is answered — its key label
    // must not appear anywhere, only the generic locked placeholder.
    expect(screen.queryByText(/rules_kwhere/)).toBeNull();
    expect(screen.getByText('rules_stepLocked')).not.toBeNull();
    expect(screen.getByText(/rules_kwhat/)).not.toBeNull();
  });

  it('never plays the demo past `animLimit` (qAt) before the chain is answered, and continues past it once done', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const anim = stubAnimationFrame();
    await startPractice();

    fireEvent.click(screen.getByRole('button', { name: /rules_play|rules_replay/ }));

    // Each tick's dt is clamped to 0.05s by `useAnimationFrame` itself, so a
    // huge synthetic gap can only ever advance `t` by 0.05 per call — drive
    // enough of them to comfortably reach (and try to exceed) `qAt`.
    let now = 0;
    for (let i = 0; i < 200; i++) {
      now += 10_000;
      anim.tick(now);
    }

    const [expectedX, expectedY] = ipos(FIXTURE_SCENARIO.disc.kf, FIXTURE_SCENARIO.qAt);
    expect(discGroup().getAttribute('transform')).toBe(`translate(${expectedX} ${expectedY})`);

    // Answer both steps to complete the chain. With `Math.random` stubbed to
    // 0, the reversed 2-option order puts step 1's correct option ("Right1")
    // first, but step 2's correct option ("Right0") second — the shuffle is
    // per-step, not "always position 0".
    fireEvent.click(screen.getAllByRole('button', { name: /Wrong0|Right1/ })[0]);
    await screen.findByText('Step2?');
    fireEvent.click(screen.getAllByRole('button', { name: /Right0|Wrong1/ })[1]);
    await screen.findByText(/rules_correct/);

    // The chain is done — `animLimit` now allows playing through to `dur`.
    for (let i = 0; i < 200; i++) {
      now += 10_000;
      anim.tick(now);
    }
    const [doneX, doneY] = ipos(FIXTURE_SCENARIO.disc.kf, FIXTURE_SCENARIO.dur);
    expect(discGroup().getAttribute('transform')).toBe(`translate(${doneX} ${doneY})`);

    anim.restore();
    randomSpy.mockRestore();
  });
});

describe('RulesTrainer — exam mode', () => {
  it('never reveals the resolution once the chain is complete — the demo stays at qAt (the strictest spoiler case)', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const anim = stubAnimationFrame();
    await startExamFlow();

    fireEvent.click(screen.getByRole('button', { name: /rules_play|rules_replay/ }));
    let now = 0;
    for (let i = 0; i < 200; i++) {
      now += 10_000;
      anim.tick(now);
    }
    const [qAtX, qAtY] = ipos(FIXTURE_SCENARIO.disc.kf, FIXTURE_SCENARIO.qAt);
    expect(discGroup().getAttribute('transform')).toBe(`translate(${qAtX} ${qAtY})`);

    // Answer step 1 (the pacing delay commits it after 350ms).
    fireEvent.click(screen.getByRole('button', { name: /Right1/ }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await screen.findByText('Step2?');

    for (let i = 0; i < 50; i++) {
      now += 10_000;
      anim.tick(now);
    }
    expect(discGroup().getAttribute('transform')).toBe(`translate(${qAtX} ${qAtY})`);

    // Answer step 2 — completes the whole chain. Even though `answer.done`
    // is now `true`, `animLimit` in exam mode ignores that entirely.
    fireEvent.click(screen.getByRole('button', { name: /Right0/ }));
    for (let i = 0; i < 50; i++) {
      now += 10_000;
      anim.tick(now);
    }
    expect(discGroup().getAttribute('transform')).toBe(`translate(${qAtX} ${qAtY})`);
    // No verdict text ever leaked either, even while the completed step
    // sits disabled waiting out its pacing delay.
    expect(screen.queryByText(/why0|why1/)).toBeNull();

    anim.restore();
    randomSpy.mockRestore();
  });

  it('shows exactly one step at a time, with no verdict and no `why`', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    await startExamFlow();

    // Only step 1's two options are on screen — no locked placeholder for
    // step 2 (exam hides everything but the live step outright).
    expect(screen.queryByText('Step2?')).toBeNull();
    expect(screen.queryByText('rules_stepLocked')).toBeNull();
    expect(currentExamOptionButtons()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /Wrong0/ }));
    // No why text, even for the option just clicked, and even though it is
    // now visibly disabled.
    expect(screen.queryByText(/why0|why1/)).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await screen.findByText('Step2?');

    // Step 1 is gone entirely now — exam never shows more than one step,
    // unlike practice where an answered step stays visible (disabled).
    expect(screen.queryByText('Step1?')).toBeNull();
    expect(screen.queryByRole('button', { name: /Wrong0|Right1/ })).toBeNull();
    expect(currentExamOptionButtons()).toHaveLength(2);

    randomSpy.mockRestore();
  });

  it('exam length is min(EXAM_N, poolSize), and every selected level can appear', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.3);
    render(<RulesTrainer locale='en' />);
    // Both fixture levels stay selected (the default) — pool size is 2
    // (one single-scenario level each), well under the real `EXAM_N` (10),
    // so `startExam` must draw both.
    fireEvent.click(await screen.findByRole('button', { name: /🎓 rules_startExam/ }));
    await screen.findByText(/rules_examQ 1 \/ 2/);

    const seenTitles = new Set<string>();
    for (let i = 0; i < 3; i++) {
      if (screen.queryByText(/rules_examResTitle/)) break;
      const heading = screen.queryByRole('heading', { level: 2 });
      if (heading?.textContent) seenTitles.add(heading.textContent);
      fireEvent.click(currentExamOptionButtons()[0] as HTMLElement);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
    }

    await screen.findByText(/rules_examResTitle/);
    expect(seenTitles).toEqual(new Set(['Fixture title', 'Fixture title 2']));

    randomSpy.mockRestore();
  });

  it('review reveals verdicts and `why`, using the SAME option order the exam displayed (not a fresh shuffle)', async () => {
    // A non-constant rng: if review ever recomputed a fresh permutation
    // instead of reusing `ExamState.perms[k]`, a constant stub could not
    // tell the difference (both calls would just reproduce the same
    // shuffle) — this is the same trap the practice-mode "does not
    // reshuffle" test above calls out.
    let call = 0;
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => (++call <= 50 ? 0 : 0.9));
    await startExamFlow();

    const step1OrderExam = screen
      .getAllByRole('button', { name: /Wrong0|Right1/ })
      .map((b) => b.textContent);

    fireEvent.click(screen.getByRole('button', { name: /Right1/ }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await screen.findByText('Step2?');

    const step2OrderExam = screen
      .getAllByRole('button', { name: /Right0|Wrong1/ })
      .map((b) => b.textContent);

    fireEvent.click(screen.getByRole('button', { name: /Wrong1/ }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    await screen.findByText(/rules_examResTitle/);
    fireEvent.click(screen.getByText('Fixture title'));
    await screen.findByText('rules_backToResults');

    const step1OrderReview = screen
      .getAllByRole('button', { name: /Wrong0|Right1/ })
      .map((b) => b.textContent);
    const step2OrderReview = screen
      .getAllByRole('button', { name: /Right0|Wrong1/ })
      .map((b) => b.textContent);

    expect(step1OrderReview).toEqual(step1OrderExam);
    expect(step2OrderReview).toEqual(step2OrderExam);

    // Full reveal: `why` now shows for every option of every step (once
    // per step, so twice total across the two steps).
    expect(screen.getAllByText('why0')).toHaveLength(2);
    expect(screen.getAllByText('why1')).toHaveLength(2);

    randomSpy.mockRestore();
  });

  it('the cheat sheet is reachable from the intro screen but never during an exam', async () => {
    render(<RulesTrainer locale='en' />);

    // Available (and renders real content) from the intro screen.
    fireEvent.click(await screen.findByRole('button', { name: 'rules_cheat' }));
    await screen.findByText('rules_cheatTitle');
    fireEvent.click(screen.getByRole('button', { name: 'rules_close' }));
    expect(screen.queryByText('rules_cheatTitle')).toBeNull();

    // No trigger exists once an exam starts.
    await selectOnlyLevel1();
    fireEvent.click(await screen.findByRole('button', { name: /🎓 rules_startExam/ }));
    await screen.findByText('Step1?');

    expect(screen.queryByRole('button', { name: 'rules_cheat' })).toBeNull();
    expect(screen.queryByText('rules_cheatTitle')).toBeNull();
  });
});
