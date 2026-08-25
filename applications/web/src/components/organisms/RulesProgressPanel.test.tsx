// Tests for RulesProgressPanel — see `docs/plans/rules-trainer.md` Phase 2
// step 12. Guarded on `isSignedIn` INSIDE the component (never 401 the
// signed-out visitor), and the mastered badge is driven strictly by the
// server-computed `mastered` flag (see `packages/rules`'s `mastery.ts`).
import { RulesProgress } from '@sideline/domain';
import { render, screen, waitFor } from '@testing-library/react';
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

const { mockMyProgress } = vi.hoisted(() => ({ mockMyProgress: vi.fn() }));

vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: () => Effect.succeed({ rulesTrainer: { myProgress: mockMyProgress } }) },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError', message }) },
  useRun: () => mockRun,
}));

// A single, STABLE function reference — mirroring production, where
// `useRun()` reads a `RunProvider`-supplied value from context rather than
// constructing a new closure per render. A fresh closure per call would make
// `run` change identity every render, which (since the component's own fetch
// effect depends on `run`, matching `PendingDiscordJoinBanner`'s own
// precedent) would refetch forever instead of once per `refreshToken`.
//
// Really executes the piped Effect (via `Effect.option`, mirroring
// `runPromiseClient`'s own shape minus the toast side effects) so
// `Effect.mapError`/`Effect.tap` in the component behave for real, rather
// than being a pass-through stub that could hide a wiring bug.
const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.option(effect));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { RulesProgressPanel } = await import('~/components/organisms/RulesProgressPanel.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(
  overrides: {
    packages?: readonly RulesProgress.RulesPackageMastery[];
    overall?: RulesProgress.RulesOverallMastery;
  } = {},
): RulesProgress.RulesMasterySummary {
  const packages =
    overrides.packages ??
    ([
      new RulesProgress.RulesPackageMastery({
        level: 1,
        strength: 0.9,
        mastered: true,
        freshCount: 12,
        everCorrectCount: 13,
        total: 13,
      }),
      new RulesProgress.RulesPackageMastery({
        level: 2,
        strength: 0.1,
        mastered: false,
        freshCount: 1,
        everCorrectCount: 2,
        total: 9,
      }),
    ] as const);
  const overall =
    overrides.overall ??
    new RulesProgress.RulesOverallMastery({ strength: 0.5, masteredCount: 1, totalScenarios: 22 });
  return new RulesProgress.RulesMasterySummary({ packages, overall });
}

beforeEach(() => {
  mockMyProgress.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RulesProgressPanel', () => {
  it('signed out: renders only the sign-in hint and never calls `myProgress`', async () => {
    render(<RulesProgressPanel locale='en' isSignedIn={false} />);

    expect(await screen.findByText('rules_signInToSave')).not.toBeNull();
    expect(screen.queryByText('rules_progressTitle')).toBeNull();
    expect(mockMyProgress).not.toHaveBeenCalled();
  });

  it('renders a row per package, with the mastered badge driven only by the `mastered` flag', async () => {
    mockMyProgress.mockReturnValue(Effect.succeed(makeSummary()));
    render(<RulesProgressPanel locale='en' isSignedIn />);

    await waitFor(() => expect(mockMyProgress).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Level 1 · The pull')).not.toBeNull();
    expect(screen.getByText('Level 2 · Marking infractions')).not.toBeNull();

    // Level 1 is `mastered: true`, level 2 is not — exactly one badge.
    expect(screen.getAllByText('rules_progressMastered')).toHaveLength(1);
    expect(screen.getByText(/rules_progressFresh:.*"fresh":12.*"total":13/)).not.toBeNull();
  });

  it('renders the empty state when nothing has ever been answered correctly', async () => {
    mockMyProgress.mockReturnValue(
      Effect.succeed(
        makeSummary({
          packages: [
            new RulesProgress.RulesPackageMastery({
              level: 1,
              strength: 0,
              mastered: false,
              freshCount: 0,
              everCorrectCount: 0,
              total: 13,
            }),
          ],
          overall: new RulesProgress.RulesOverallMastery({
            strength: 0,
            masteredCount: 0,
            totalScenarios: 13,
          }),
        }),
      ),
    );
    render(<RulesProgressPanel locale='en' isSignedIn />);

    expect(await screen.findByText('rules_progressEmpty')).not.toBeNull();
    expect(screen.queryByText('Level 1 · The pull')).toBeNull();
  });

  it('refetches when `refreshToken` changes, but not on every render', async () => {
    mockMyProgress.mockReturnValue(Effect.succeed(makeSummary()));
    const { rerender } = render(<RulesProgressPanel locale='en' isSignedIn refreshToken={0} />);
    await waitFor(() => expect(mockMyProgress).toHaveBeenCalledTimes(1));

    rerender(<RulesProgressPanel locale='en' isSignedIn refreshToken={0} />);
    expect(mockMyProgress).toHaveBeenCalledTimes(1);

    rerender(<RulesProgressPanel locale='en' isSignedIn refreshToken={1} />);
    await waitFor(() => expect(mockMyProgress).toHaveBeenCalledTimes(2));
  });
});
