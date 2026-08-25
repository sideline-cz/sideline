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

vi.mock('@sideline/rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sideline/rules')>();
  return {
    ...actual,
    LEVELS: [1],
    LEVEL_META: {
      1: { level: 1, name: { en: 'Fixture package', cs: 'Fixture package' }, scenarioCount: 1 },
    },
  };
});

vi.mock('@sideline/rules/reference', () => ({ RULES: {}, SIGNALS: {} }));

// The organism loads content through the web-local map, not the package's
// own PACKAGE_LOADERS — see `~/lib/rules/loaders.ts`.
vi.mock('~/lib/rules/loaders.js', () => ({
  WEB_PACKAGE_LOADERS: { 1: () => Promise.resolve(FIXTURE_PACKAGE) },
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

async function startPractice() {
  render(<RulesTrainer locale='en' />);
  fireEvent.click(await screen.findByRole('button', { name: /rules_start/ }));
  // Practice screen renders once the (mocked) package promise resolves.
  await screen.findByText('Step1?');
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
