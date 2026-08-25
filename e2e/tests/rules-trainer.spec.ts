import type { Locator, Page } from '@playwright/test';
import type { Lang, Level, Option, Scenario } from '@sideline/rules';
import { createAnimator, LEVELS, text } from '@sideline/rules';
import { ALL_PACKAGES } from '@sideline/rules/content';
import { expect, unauthenticatedTest as test } from '../fixtures/api-mocks.js';

/**
 * E2E coverage for the Ultimate rules trainer at `/en/rules` (ported from
 * `~/Projects/frisbee-rules/test/chains.mjs`).
 *
 * The prototype drove the page through module-scope globals (`anim.t`,
 * `state`, `currentAnswer()`, `.opt[data-opt]`, `#nextbtn`, …) that simply do
 * not exist in this React port — state is component-local. Every assertion
 * here is DOM-driven instead: option buttons are found by their translated
 * text (never by shuffle position), and the "frozen demo" claim is verified
 * by reading the disc's rendered SVG `transform` rather than an internal
 * `anim.t` — see `expectFrozenAtQAt`/`expectResolutionPlayed` below, which
 * compute the expected position straight from the engine (`createAnimator`)
 * and compare it numerically, so the check is precise (content-derived, not
 * a fuzzy "did it move" heuristic) while still tolerating the last-bit
 * float differences a JS engine's JIT tiering can introduce.
 *
 * Why this suite exists at all: during development, `pnpm build`, `pnpm
 * check` and the full unit suite were all green while the trainer 404'd on
 * every content chunk at runtime (see `~/lib/rules/loaders.ts`'s doc
 * comment). Unit tests mock the loaders, so only a real browser catches
 * that class of bug — hence test 1 below.
 */

const ALL_SCENARIOS: readonly Scenario[] = ALL_PACKAGES.flatMap((p) => p.scenarios);

// The sweep is split into ONE TEST PER LEVEL rather than a single loop over all
// 109 scenarios, so that Playwright's existing 8-way sharding distributes it and
// the full sweep runs on every PR.
//
// The alternative — one long test gated behind an env flag — was tried first and
// rejected: it costs ~10.6 min serially, so it would never have run in CI, and
// coverage that only runs when someone remembers a flag is a soft version of the
// dropped-suite risk the plan warns about. Sharded, the largest level (9, with
// 20 scenarios) is ~2 min, which lands on one shard rather than all of them.
//
// Each chain's freeze/resolution waits are tied to the scenario's own authored
// `qAt`/`dur` — genuine animation seconds, not fakeable without reaching into
// `applications/web` — so per-scenario cost (~5.8s) is a floor, not slack to be
// optimised away.
const SCENARIOS_BY_LEVEL: ReadonlyArray<readonly [Level, readonly Scenario[]]> = LEVELS.map(
  (level: Level) => {
    const inLevel = ALL_SCENARIOS.filter((sc) => sc.level === level);
    if (inLevel.length === 0) {
      throw new Error(`no scenario found for level ${level} — content/LEVELS drifted`);
    }
    return [level, inLevel] as const;
  },
);

const STEP_WORD: Record<Lang, string> = { en: 'Step', cs: 'Krok' };
const LOCKED_TEXT: Record<Lang, string> = {
  en: 'unlocks after the step above',
  cs: 'odemkne se po kroku výše',
};
const START_BUTTON: Record<Lang, RegExp> = {
  en: /^Practice \(\d+\)$/,
  cs: /^Trénink \(\d+\)$/,
};

// The API backend (`localhost:3001`) is not running in the preview harness
// this suite drives against (`playwright.config.ts`'s `webServer` only
// builds+previews web) — Chromium logs a bare "Failed to load resource:
// net::ERR_CONNECTION_REFUSED" for that (no URL in the message text, so this
// cannot be scoped any tighter than the error code itself; nothing else in
// this harness produces that specific browser-generated network error).
// `unauthenticatedTest`'s `fastAuth` fixture deliberately mocks `/auth/me`
// to return 401 so `beforeLoad` resolves fast, which Chromium likewise logs
// as a bare "Failed to load resource: … 401 (Unauthorized)" with no URL —
// also expected, also not scopable any tighter. Both are filtered
// specifically by message content, not by blanket-ignoring every error.
const IGNORED_ERROR_PATTERNS: readonly RegExp[] = [
  /net::ERR_CONNECTION_REFUSED/,
  /status of 401 \(Unauthorized\)/,
];

function isIgnoredError(message: string): boolean {
  return IGNORED_ERROR_PATTERNS.some((re) => re.test(message));
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function svgField(page: Page): Locator {
  return page.locator('svg[role="img"]');
}

/** The `<g>` that positions the disc — identified structurally by the disc's
 * own (non-reused) radius, since there is no test id on it. */
function discGroup(page: Page): Locator {
  return svgField(page)
    .locator('g')
    .filter({ has: page.locator('circle[r="0.78"]') });
}

async function startPractice(page: Page, locale: Lang): Promise<void> {
  await page.getByRole('button', { name: START_BUTTON[locale] }).click();
  await expect(svgField(page)).toBeVisible({ timeout: 15_000 });
}

/** Jumps directly to pool position `position1Based` via the situation
 * "pips" row — real UI, not a shortcut invented for the test — letting a
 * sampled sweep skip the 100 scenarios it does not need to visit. */
async function gotoPoolPosition(page: Page, position1Based: number): Promise<void> {
  await page.getByRole('button', { name: String(position1Based), exact: true }).click();
}

/** The rendered container for chain step `stepIndex` (0-based) — matched on
 * its own "Step N/M" header text, which every step state (locked / current /
 * answered) always renders exactly once. */
function stepContainer(page: Page, stepIndex: number, locale: Lang): Locator {
  return page.locator('.rounded-md.border.p-3', {
    hasText: new RegExp(`^${STEP_WORD[locale]} ${stepIndex + 1}/`),
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An option button's accessible name is its `A`/`B`/`C`/`D` letter directly
 * followed by its text, with no separator (`"AGoal"`, not `"A Goal"`) — so
 * matching must anchor on "one letter, then exactly this text, then
 * nothing", not a bare substring: some option texts (e.g. "Goal") are
 * substrings of OTHER options in the very same step (e.g. "No goal — …",
 * "… on the goal line"), which a plain substring match cannot tell apart. */
function optionButtonName(label: string): RegExp {
  // Letters are `['A', 'B', 'C', 'D']` in `RulesTrainer.tsx` (content never
  // has more than 4 options per step — see `packages/rules/AGENTS.md`).
  return new RegExp(`^[A-D]${escapeRegExp(label)}$`);
}

/** Display position (0-based) of the button whose text is exactly the `A`/
 * `B`/`C`/`D` letter followed by `label`, among a step container's option
 * buttons, or -1 if not found. */
async function optionPosition(container: Locator, label: string): Promise<number> {
  const buttons = container.getByRole('button');
  const count = await buttons.count();
  const pattern = optionButtonName(label);
  for (let i = 0; i < count; i++) {
    const t = (await buttons.nth(i).textContent()) ?? '';
    if (pattern.test(t)) return i;
  }
  return -1;
}

function findOption(step: Scenario['steps'][number], predicate: (o: Option) => boolean): Option {
  const opt = step.opts.find(predicate);
  if (!opt) throw new Error('no option in this step matches the predicate');
  return opt;
}

/** Locates the (unique, currently live) option button for step `stepIndex`
 * whose option matches `predicate` — e.g. `o.ok === true` for the correct
 * answer. Matched by translated text, never by shuffle position, since the
 * whole point of the shuffle is that position is not stable. */
async function optionButton(
  page: Page,
  scenario: Scenario,
  stepIndex: number,
  locale: Lang,
  predicate: (o: Option) => boolean,
): Promise<Locator> {
  const step = scenario.steps[stepIndex];
  if (!step) throw new Error(`scenario ${scenario.id} has no step ${stepIndex}`);
  const opt = findOption(step, predicate);
  const label = text(opt.t, locale);
  const container = stepContainer(page, stepIndex, locale);
  await expect(container).toHaveCount(1);
  // `.locator('button').filter({ hasText })` (raw textContent), not
  // `getByRole('button', { name })` (computed accessible name) — the two
  // disagree here: the button's own DOM has no space between the `A`/`B`/…
  // letter span and the option text, but accessible-name computation
  // inserts one between the two text-producing nodes.
  const btn = container.locator('button').filter({ hasText: optionButtonName(label) });
  await expect(btn).toHaveCount(1);
  return btn;
}

// ---------------------------------------------------------------------------
// The spoiler-gate assertions
// ---------------------------------------------------------------------------

/** Parses a rendered `translate(x y)` SVG transform into its two numbers. */
function parseTranslate(transform: string | null): readonly [number, number] {
  const m = transform?.match(/^translate\(([^ ]+) ([^)]+)\)$/);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`unexpected disc transform: ${transform}`);
  }
  return [Number(m[1]), Number(m[2])];
}

/** Asserts the disc is sitting where the engine says it should be at time
 * `t`, computed independently here via `createAnimator` rather than read off
 * any app internal — a numeric comparison (tolerant of the last-bit
 * differences a JS engine can produce for the very same formula depending on
 * JIT tier — real and observed across a 109-scenario sweep of `hermiteAt`
 * calls, not a "did it move" heuristic weakening). Waits (retrying via
 * `expect(...).toPass`, not a fixed sleep) because the browser is genuinely
 * still animating towards it in real time. */
async function expectDiscAt(page: Page, scenario: Scenario, t: number, timeoutMs: number) {
  const [ex, ey] = createAnimator(scenario).discAt(t);
  await expect(async () => {
    const transform = await discGroup(page).getAttribute('transform');
    const [x, y] = parseTranslate(transform);
    expect(Math.abs(x - ex)).toBeLessThan(1e-6);
    expect(Math.abs(y - ey)).toBeLessThan(1e-6);
  }).toPass({ timeout: timeoutMs });
}

/** The freeze half of the spoiler gate: the demo must be sitting at `qAt`
 * and — this is the actual regression guard — must STILL be sitting there a
 * little later, i.e. it never sneaks past `qAt` on its own. */
async function expectFrozenAtQAt(page: Page, scenario: Scenario) {
  await expectDiscAt(page, scenario, scenario.qAt, 15_000);
  await page.waitForTimeout(500);
  await expectDiscAt(page, scenario, scenario.qAt, 1_000);
}

/** The reveal half: once the chain is fully answered, the demo must resume
 * and actually reach the end. */
async function expectResolutionPlayed(page: Page, scenario: Scenario) {
  await expectDiscAt(page, scenario, scenario.dur, 20_000);
}

/** Nothing about step `stepIndex` (the live one) or anything beyond it may
 * be visible before it is answered: no `why` text for its options, and every
 * step still to come must render as a locked placeholder with no key label
 * (the regression the plan calls out by name — a locked step's dimension
 * name, e.g. "Where it restarts", is itself a spoiler). */
async function expectNoSpoilersBeyond(
  page: Page,
  scenario: Scenario,
  liveStepIndex: number,
  locale: Lang,
) {
  const liveStep = scenario.steps[liveStepIndex];
  if (liveStep) {
    for (const opt of liveStep.opts) {
      const why = text(opt.why, locale);
      if (why.trim().length > 0) {
        await expect(page.getByText(why, { exact: true })).toHaveCount(0);
      }
    }
  }

  for (let i = liveStepIndex + 1; i < scenario.steps.length; i++) {
    const container = stepContainer(page, i, locale);
    await expect(container).toHaveCount(1);
    await expect(container).toContainText(LOCKED_TEXT[locale]);
    const containerText = (await container.textContent()) ?? '';
    // A key label is always rendered as ` · {label}` right after the step
    // header — its absence is exactly "no key label leaked".
    expect(containerText).not.toContain('·');
  }
}

async function expectFeedbackVisible(
  page: Page,
  scenario: Scenario,
  locale: Lang,
  expectedOk: boolean,
) {
  const verdict = expectedOk ? 'Correct!' : 'Not quite.';
  await expect(page.getByText(verdict, { exact: false }).first()).toBeVisible();
  const explain = text(scenario.explain, locale);
  if (explain.trim().length > 0) {
    await expect(page.getByText(explain, { exact: true })).toBeVisible();
  }
}

/**
 * Walks one scenario's whole chain, verifying the spoiler gate at every
 * step, then asserts the resolution plays and the explanation appears.
 * `wrongFirstStep` mirrors the prototype's `wrongOn = i === 2`: pick a wrong
 * answer on step 0, correct answers after.
 */
async function runScenarioAndVerify(
  page: Page,
  scenario: Scenario,
  locale: Lang,
  opts: { readonly wrongFirstStep?: boolean } = {},
) {
  await expect(page.getByRole('heading', { level: 2 })).toContainText(text(scenario.title, locale));

  // On arrival at a freshly-entered scenario, `RulesTrainer.tsx` resets
  // `animT` to 0 in a `useEffect` scoped to `currentId` — which commits
  // AFTER the render that already shows the new scenario. For one render,
  // the disc briefly shows the NEW scenario's geometry at the OLD (leftover)
  // `animT`, which some content pairs (e.g. two "the disc comes to rest at
  // ~x=34" scenarios back to back) can coincidentally match the new
  // scenario's own qAt-position — a one-frame false "already frozen" read.
  // Waiting past the app's own documented 500ms autoplay-start delay before
  // the first freeze check avoids racing that transient.
  const n = scenario.steps.length;
  for (let i = 0; i < n; i++) {
    if (i === 0) await page.waitForTimeout(600);
    await expectFrozenAtQAt(page, scenario);
    await expectNoSpoilersBeyond(page, scenario, i, locale);

    const wrong = opts.wrongFirstStep === true && i === 0;
    const btn = await optionButton(page, scenario, i, locale, (o) =>
      wrong ? o.ok !== true : o.ok === true,
    );
    await btn.click();
  }

  await expectResolutionPlayed(page, scenario);
  await expectFeedbackVisible(page, scenario, locale, opts.wrongFirstStep !== true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Rules trainer', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isIgnoredError(msg.text())) {
        consoleErrors.push(`console: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      if (!isIgnoredError(err.message)) {
        consoleErrors.push(`pageerror: ${err.message}`);
      }
    });
  });

  test.afterEach(() => {
    expect(consoleErrors, `unexpected console/page errors:\n${consoleErrors.join('\n')}`).toEqual(
      [],
    );
  });

  // This is the test that would have caught the loader 404 bug: `pnpm
  // build`, `pnpm check` and the whole unit suite were green while every
  // content chunk 404'd at runtime, because unit tests mock the loaders.
  test('loads real scenario content when practice starts (regression guard for the content-loader 404 bug)', async ({
    page,
  }) => {
    await page.goto('/en/rules');
    await startPractice(page, 'en');

    const first = ALL_SCENARIOS[0];
    if (!first) throw new Error('content package is empty');
    await expect(page.getByRole('heading', { level: 2 })).toContainText(
      `1/${ALL_SCENARIOS.length}`,
    );
    await expect(page.getByRole('heading', { level: 2 })).toContainText(text(first.title, 'en'));
    // The field actually drew something real, not an empty/placeholder SVG.
    await expect(svgField(page).locator('circle')).not.toHaveCount(0);
  });

  // One test per level — see SCENARIOS_BY_LEVEL. Together these cover all 109
  // situations on every PR; individually each is small enough to shard.
  for (const [level, scenarios] of SCENARIOS_BY_LEVEL) {
    test(`spoiler gate holds for every situation in level ${level} (${scenarios.length} situations)`, async ({
      page,
    }) => {
      // ~5.8s per scenario is a floor (authored animation seconds), so budget
      // generously — level 9 is 20 situations.
      test.setTimeout(Math.max(5, scenarios.length) * 60_000);

      await page.goto('/en/rules');
      await startPractice(page, 'en');

      for (const scenario of scenarios) {
        // Navigate by pool position rather than clicking "Next situation"
        // repeatedly: a level's scenarios are contiguous in the pool, but
        // starting from the pool's first item would mean walking every earlier
        // level's chains too.
        const position = ALL_SCENARIOS.indexOf(scenario) + 1;
        await gotoPoolPosition(page, position);
        await runScenarioAndVerify(page, scenario, 'en');
      }
    });
  }

  test('a wrong pick is handled: verdict shows incorrect, explanation still appears', async ({
    page,
  }) => {
    // Mirrors the prototype's `wrongOn = i === 2` — the 3rd scenario overall.
    const scenario = ALL_SCENARIOS[2];
    if (!scenario) throw new Error('need at least 3 scenarios for this test');

    await page.goto('/en/rules');
    await startPractice(page, 'en');
    await gotoPoolPosition(page, 3);
    await runScenarioAndVerify(page, scenario, 'en', { wrongFirstStep: true });
  });

  test('the shuffle is real: the correct option is not always displayed first', async ({
    page,
  }) => {
    // `ok: true` sits at index 0 in every authored step (see
    // `packages/rules/src/engine/score.ts`'s doc comment) — if the display
    // order were ever the identity permutation, the correct answer would
    // always render first. Checked across every scenario's first step,
    // since this is cheap (no animation waits, just DOM order).
    await page.goto('/en/rules');
    await startPractice(page, 'en');

    const positions: number[] = [];
    for (let i = 0; i < ALL_SCENARIOS.length; i++) {
      const scenario = ALL_SCENARIOS[i];
      const step = scenario?.steps[0];
      if (!scenario || !step) continue;
      await gotoPoolPosition(page, i + 1);
      const container = stepContainer(page, 0, 'en');
      await expect(container).toHaveCount(1);
      const correct = findOption(step, (o) => o.ok === true);
      const pos = await optionPosition(container, text(correct.t, 'en'));
      expect(
        pos,
        `scenario ${scenario.id} step 0: correct option not found in DOM`,
      ).toBeGreaterThanOrEqual(0);
      positions.push(pos);
    }

    expect(
      positions.some((p) => p !== 0),
      `expected at least one shuffled (non-first) position across ${positions.length} scenarios, got all-first`,
    ).toBe(true);
  });

  test('answering a situation persists across reload (localStorage)', async ({ page }) => {
    const scenario = ALL_SCENARIOS[0];
    const next = ALL_SCENARIOS[1];
    if (!scenario || !next) throw new Error('need at least 2 scenarios for this test');

    await page.goto('/en/rules');
    await startPractice(page, 'en');
    await runScenarioAndVerify(page, scenario, 'en');

    await page.reload();
    await startPractice(page, 'en');

    // Progress survived the reload: the run resumes on the first
    // UNANSWERED scenario (not scenario 1 again), and the score badge
    // already reflects the answer from before the reload.
    await expect(page.getByRole('heading', { level: 2 })).toContainText(text(next.title, 'en'));
    await expect(page.getByText(`1 / ${ALL_SCENARIOS.length}`)).toBeVisible();
  });

  test('/cs/rules is noindex, shows the Czech review notice, and renders Czech chrome', async ({
    page,
  }) => {
    await page.goto('/cs/rules');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.getByText('Český překlad se kontroluje')).toBeVisible();
    await expect(page.getByRole('button', { name: START_BUTTON.cs })).toBeVisible();
  });

  test('/en/rules is not noindex', async ({ page }) => {
    await page.goto('/en/rules');
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  });

  test('/rules redirects to the negotiated locale', async ({ page }) => {
    await page.goto('/rules');
    await expect(page).toHaveURL(/\/en\/rules$/);
  });

  test('the homepage card reaches a working trainer, not a 404', async ({ page }) => {
    // The plan requires the homepage surface and the route to ship together,
    // "or the homepage links to a 404". This is that assertion: follow the card
    // the way a visitor would, and confirm the trainer actually starts — the
    // card is the only real link in a grid of static demos, so a broken href
    // would look exactly like its inert siblings.
    await page.goto('/');
    await page.waitForFunction(() => !document.body.textContent?.includes('Loading...'), {
      timeout: 30000,
    });

    const card = page.getByRole('link', { name: /rules trainer/i });
    await expect(card).toBeVisible();
    await card.click();

    await expect(page).toHaveURL(/\/(en|cs)\/rules$/);
    await expect(page.getByRole('button', { name: START_BUTTON.en })).toBeVisible({
      timeout: 30000,
    });
  });
});
