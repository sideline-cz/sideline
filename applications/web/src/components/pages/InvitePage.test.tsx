/**
 * TDD for PR-4 of the Discord onboarding fix (`.work-plans/discord-onboarding-fix-plan.md`),
 * BLOCKER 4 (review of PR-4).
 *
 * Root cause C: `InvitePage` used to call `onJoined` only when `requiresReauth` was false, so
 * `setPendingDiscordJoin` never ran for a user who needs to re-authorize — even though
 * `joinViaInvite` already persisted the membership AND the acceptance row. PR-4 first fixed this
 * by splitting the single `onJoined` callback into `onJoinPersisted` (fired unconditionally) and
 * `onJoinComplete` (fired only when `requiresReauth` is false) — but both had the identical
 * signature `(result: Invite.JoinResult) => void`, so swapping them at the call site
 * (`routes/invite.$code.tsx`) compiled cleanly and would silently reintroduce the exact same bug.
 *
 * BLOCKER 4 collapses the two callbacks into a single `onJoinResult(result, { navigated })` prop.
 * There is now exactly one function reference to wire up, so there is nothing left to swap:
 *   - It is called exactly once per join, unconditionally, as soon as the server call succeeds.
 *   - `navigated` is `true` iff `requiresReauth` is `false` — it tells the caller whether it
 *     should ALSO navigate away (the old `onJoinComplete` half), on top of always persisting.
 *
 * These tests pin that contract.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { Effect, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  // Pass-through: assertions below match on the raw key, mirroring
  // HomePage.test.tsx's fallback-key convention.
  tr: (key: string) => key,
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/components/organisms/LanguageSwitcher', () => ({
  LanguageSwitcher: () => null,
}));

const { mockJoinViaInvite } = vi.hoisted(() => ({
  mockJoinViaInvite: vi.fn(),
}));

// A `run` that really executes the piped Effect via `Effect.option` — mirroring
// `RulesTrainer.test.tsx` — so `Effect.tap`'s `onJoinResult` call inside `handleJoin` actually
// runs, rather than being a pass-through stub.
const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.option(effect));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () => Effect.succeed({ invite: { joinViaInvite: mockJoinViaInvite } }),
  },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError', message }) },
  useRun: () => mockRun,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { InvitePage } = await import('~/components/pages/InvitePage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testInvite = {
  teamName: 'Test Team',
  teamId: 'team-1',
  code: 'test-code',
  groupName: Option.none<string>(),
  inviterName: Option.none<string>(),
} as any;

const makeJoinResult = (requiresReauth: boolean) => ({
  teamId: 'team-1',
  roleNames: ['Player'],
  isProfileComplete: true,
  requiresReauth,
  // BLOCKER 1 (third review of PR-4): `JoinResult.acceptanceId` is no longer `Option`.
  acceptanceId: 'acceptance-1',
});

const renderInvitePage = (overrides?: {
  onJoinResult?: (result: unknown, meta: unknown) => void;
}) => {
  const onJoinResult = overrides?.onJoinResult ?? vi.fn();
  const onSignIn = vi.fn();
  const onReauth = vi.fn();

  render(
    <InvitePage
      {...({
        isAuthenticated: true,
        invite: testInvite,
        code: 'test-code',
        onJoinResult,
        onSignIn,
        onReauth,
      } as any)}
    />,
  );

  return { onJoinResult, onSignIn, onReauth };
};

describe('InvitePage — the single onJoinResult callback contract (BLOCKER 4, review of PR-4)', () => {
  it('calls onJoinResult once with navigated: false when requiresReauth is true', async () => {
    const result = makeJoinResult(true);
    mockJoinViaInvite.mockReturnValue(Effect.succeed(result));

    const { onJoinResult } = renderInvitePage();

    screen.getByRole('button', { name: 'invite_joinButton' }).click();

    await waitFor(() => {
      expect(onJoinResult).toHaveBeenCalledTimes(1);
    });
    // The bug this PR fixes: a join that requires re-auth must still be reported to the caller
    // (so it can persist the acceptance) — but `navigated` must be false, so the caller does not
    // navigate away.
    expect(onJoinResult).toHaveBeenCalledWith(result, { navigated: false });
  });

  it('calls onJoinResult once with navigated: true when requiresReauth is false', async () => {
    const result = makeJoinResult(false);
    mockJoinViaInvite.mockReturnValue(Effect.succeed(result));

    const { onJoinResult } = renderInvitePage();

    screen.getByRole('button', { name: 'invite_joinButton' }).click();

    await waitFor(() => {
      expect(onJoinResult).toHaveBeenCalledTimes(1);
    });
    expect(onJoinResult).toHaveBeenCalledWith(result, { navigated: true });
  });

  it('renders the reauth card after a requiresReauth join — stable, passes before and after this fix', async () => {
    const result = makeJoinResult(true);
    mockJoinViaInvite.mockReturnValue(Effect.succeed(result));

    renderInvitePage();

    screen.getByRole('button', { name: 'invite_joinButton' }).click();

    await waitFor(() => {
      expect(screen.getByText('invite_reauthTitle')).toBeTruthy();
    });
    expect(screen.getByText('invite_reauthDescription')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'invite_reauthButton' })).toBeTruthy();
  });
});
