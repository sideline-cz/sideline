// TDD mode — tests written for PR-5 of the Discord onboarding fix
// (`.work-plans/discord-onboarding-fix-plan.md`, PR-5 test list items 16-25).
// PendingDiscordJoinBanner.tsx EXISTS today, but in its OLD (broken) shape:
// localStorage-only, no `teamId` prop, polls `getJoinStatus` by a stored
// `acceptanceId`, maps every poll failure to `ClientError.make('')` (an empty
// toast every 2s — `applications/web/src/lib/runtime.ts:210-245` fires
// `toast.error('')` for any non-Silent `ClientError`), never stops polling,
// and has no regenerate affordance. EVERY test below MUST FAIL against that
// implementation.
//
// Assumed post-PR-5 component contract (per the plan, steps 9-10):
//   PendingDiscordJoinBanner({ teamId: string })
//   - Sources state from `api.invite.getMyPendingDiscordJoin({ params: { teamId } })`,
//     polled every 2s — no longer keyed by a localStorage `acceptanceId`.
//   - `getPendingDiscordJoin` (localStorage) is read only as an initial hint while
//     the first request is in flight; the server response always wins once it
//     arrives, even if the hint disagrees.
//   - Renders `null` when the server has nothing pending (`Option.none()`).
//   - `state` drives the copy: 'preparing' | 'ready' | 'expired' | 'failed'.
//     - 'ready' renders `<a href={discordInviteUrl}>`; clicking it must NOT call
//       `clearPendingDiscordJoin()` (that used to permanently destroy the link on
//       one blocked-popup click — designer §1 root cause 3).
//     - 'failed' renders copy specific to `errorCode` (designer §4.4), not one
//       generic message.
//     - 'expired' renders a "Get a new invite" CTA wired to
//       `api.invite.regenerateMyDiscordInvite({ params: { teamId } })`, which
//       resumes polling on success.
//   - Polling STOPS once `state` is 'expired' or 'failed' (a terminal state must
//     not spin forever), and resumes after a successful regenerate.
//   - The poll's error is mapped to `SilentClientError`, not a plain `ClientError`,
//     so `runPromiseClient` never raises a `toast.error(...)` for it.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Effect, Option } from 'effect';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const { mockGetMyPendingDiscordJoin, mockRegenerateMyDiscordInvite } = vi.hoisted(() => ({
  mockGetMyPendingDiscordJoin: vi.fn(),
  mockRegenerateMyDiscordInvite: vi.fn(),
}));

// `mockRun` deliberately REPLICATES `runPromiseClient`'s error->toast tap
// (`applications/web/src/lib/runtime.ts:216-228`) instead of stubbing it away —
// test 23 below only means anything if a plain `ClientError` failure would
// actually reach `toast.error` the same way it does in production, and a
// `SilentClientError` failure would not. Mirrors `RulesProgressPanel.test.tsx`'s
// documented precedent for mocking `useRun`, extended to cover the toast tap.
const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.tapError((e) =>
        Effect.sync(() => {
          const tag = (e as { readonly _tag?: string })?._tag;
          if (tag === 'SilentClientError') return;
          const message = (e as { readonly message?: string })?.message ?? '';
          toast.error(message);
        }),
      ),
      Effect.option,
    ),
  );

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () =>
      Effect.succeed({
        invite: {
          getMyPendingDiscordJoin: mockGetMyPendingDiscordJoin,
          regenerateMyDiscordInvite: mockRegenerateMyDiscordInvite,
          // Stubbed harmlessly so the OLD (pre-PR-5) component — which still polls
          // `getJoinStatus` by a localStorage-derived `acceptanceId` — doesn't blow up
          // with an unhandled rejection when a test seeds `pendingJoinHint`. The future
          // component never calls this.
          getJoinStatus: () =>
            Effect.succeed({
              acceptanceId: 'legacy-unused',
              discordInviteUrl: Option.none(),
              errorCode: Option.none(),
            }),
        },
      }),
  },
  ClientError: {
    make: (message: string) => ({ _tag: 'ClientError', message }),
  },
  // `Data.TaggedError`-shaped stand-in — good enough for `e._tag === 'SilentClientError'`.
  SilentClientError: class SilentClientError {
    readonly _tag = 'SilentClientError';
    readonly message: string;
    constructor(props?: { readonly message?: string }) {
      this.message = props?.message ?? '';
    }
  },
  useRun: () => mockRun,
}));

let pendingJoinHint: Option.Option<{
  readonly acceptanceId: string;
  readonly teamId: string;
  readonly ts: number;
}> = Option.none();
const clearPendingDiscordJoinCalls: Array<true> = [];

vi.mock('~/lib/auth', () => ({
  // Consumed as `Effect.runSync(getPendingDiscordJoin)` — a real `Effect.sync` so
  // each read reflects whatever the test most recently set via `pendingJoinHint`.
  getPendingDiscordJoin: Effect.sync(() => pendingJoinHint),
  clearPendingDiscordJoin: Effect.sync(() => {
    clearPendingDiscordJoinCalls.push(true);
  }),
  setPendingDiscordJoin: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { PendingDiscordJoinBanner } = await import(
  '~/components/organisms/PendingDiscordJoinBanner.js'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-pr5';

type JoinStatusView = {
  readonly acceptanceId: string;
  readonly state: 'preparing' | 'ready' | 'expired' | 'failed';
  readonly discordInviteUrl: Option.Option<string>;
  readonly errorCode: Option.Option<string>;
};

function makeStatus(overrides: Partial<JoinStatusView> = {}): JoinStatusView {
  return {
    acceptanceId: 'acc-1',
    state: 'preparing',
    discordInviteUrl: Option.none(),
    errorCode: Option.none(),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetMyPendingDiscordJoin.mockReset();
  mockRegenerateMyDiscordInvite.mockReset();
  vi.mocked(toast.error).mockClear();
  pendingJoinHint = Option.none();
  clearPendingDiscordJoinCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PendingDiscordJoinBanner', () => {
  it('renders nothing when there is no pending join', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(Effect.succeed(Option.none()));

    const { container } = render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);
    await waitFor(() => expect(mockGetMyPendingDiscordJoin).toHaveBeenCalled());

    expect(container.firstChild).toBeNull();
  });

  it("renders the preparing state for state 'preparing'", async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(Option.some(makeStatus({ state: 'preparing' }))),
    );

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);

    expect(await screen.findByText('invite_preparingDiscordInviteDescription')).not.toBeNull();
  });

  it("renders the link for state 'ready'", async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(
        Option.some(
          makeStatus({
            state: 'ready',
            discordInviteUrl: Option.some('https://discord.gg/abc123'),
          }),
        ),
      ),
    );

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);

    const link = (await screen.findByRole('link')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://discord.gg/abc123');
  });

  it("renders the failure copy for state 'failed' with errorCode welcome_channel_missing — the SPECIFIC message", async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(
        Option.some(
          makeStatus({ state: 'failed', errorCode: Option.some('welcome_channel_missing') }),
        ),
      ),
    );

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);

    // Designer §4.4: welcome_channel_missing is a captain-actionable error, distinct from
    // the bot-permissions copy and the generic fallback — asserting the specific key (not
    // just "some failure text") is the point of this test.
    expect(await screen.findByText('discord_connect_error_captainAction')).not.toBeNull();
    expect(screen.queryByText('discord_connect_error_botPerms')).toBeNull();
    expect(screen.queryByText('discord_connect_error_generic')).toBeNull();
  });

  it("renders the regenerate CTA for state 'expired' and calls regenerateMyDiscordInvite on click", async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(Option.some(makeStatus({ state: 'expired' }))),
    );
    mockRegenerateMyDiscordInvite.mockReturnValue(
      Effect.succeed(Option.some(makeStatus({ state: 'preparing' }))),
    );

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);

    const button = await screen.findByText('discord_connect_regenerateButton');
    fireEvent.click(button);

    await waitFor(() =>
      expect(mockRegenerateMyDiscordInvite).toHaveBeenCalledWith({
        params: { teamId: TEAM_ID },
      }),
    );
  });

  it('resumes polling after a successful regenerate', async () => {
    vi.useFakeTimers();
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(Option.some(makeStatus({ state: 'expired' }))),
    );

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Guard: must actually have called the server-sourced endpoint at least once — fails
    // cleanly against today's component, which never calls it at all.
    expect(mockGetMyPendingDiscordJoin).toHaveBeenCalled();
    // 'expired' is terminal — no further automatic polling until the regenerate below.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    const callsBeforeRegenerate = mockGetMyPendingDiscordJoin.mock.calls.length;

    mockRegenerateMyDiscordInvite.mockReturnValue(
      Effect.succeed(Option.some(makeStatus({ state: 'preparing' }))),
    );
    // NOTE: deliberately `getByText` (synchronous), not `findByText` — `findByText`'s
    // internal retry loop uses `setTimeout`/`setInterval`, which fake timers freeze unless
    // explicitly advanced, and can hang the test for its real-time default timeout instead
    // of failing meaningfully. `act()` above already flushed the render.
    fireEvent.click(screen.getByText('discord_connect_regenerateButton'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Regenerate returned a non-terminal state ('preparing') — the interval must resume.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockGetMyPendingDiscordJoin.mock.calls.length).toBeGreaterThan(callsBeforeRegenerate);
  });

  it('stops polling once a terminal state is reached', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    mockGetMyPendingDiscordJoin.mockImplementation(() => {
      callCount += 1;
      return Effect.succeed(
        Option.some(
          makeStatus(
            callCount === 1
              ? { state: 'preparing' }
              : { state: 'failed', errorCode: Option.some('bot_missing_perms') },
          ),
        ),
      );
    });

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // call 1 — 'preparing'
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // call 2 — 'failed' (terminal)
    });

    const callsAtTerminal = mockGetMyPendingDiscordJoin.mock.calls.length;
    expect(callsAtTerminal).toBe(2);

    // Several more poll intervals must NOT produce any further calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 * 5);
    });
    expect(mockGetMyPendingDiscordJoin.mock.calls.length).toBe(callsAtTerminal);
  });

  // Real current regression (not hypothetical) — see the banner's `Effect.mapError(() =>
  // ClientError.make(''))` and `runtime.ts`'s `toast.error(e.message)` for any non-Silent
  // `ClientError`. Today this fires an EMPTY toast every 2s while polling fails.
  it('does not raise an error toast when polling fails', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    mockGetMyPendingDiscordJoin.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Effect.succeed(Option.some(makeStatus({ state: 'preparing' })));
      }
      return Effect.fail(new Error('simulated network failure'));
    });

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // call 1 — success
    });
    // Guard: this assertion is only meaningful if the poll actually ran against the
    // server-sourced endpoint — fails cleanly against today's component (which never
    // calls it) rather than silently passing because the poll never started.
    expect(mockGetMyPendingDiscordJoin).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // call 2 — fails
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // call 3 — fails again
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('prefers the server state over a stale localStorage entry', async () => {
    pendingJoinHint = Option.some({
      acceptanceId: 'stale-local-id',
      teamId: TEAM_ID,
      ts: Date.now(),
    });
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(
        Option.some(
          makeStatus({
            acceptanceId: 'server-id',
            state: 'ready',
            discordInviteUrl: Option.some('https://discord.gg/fresh-from-server'),
          }),
        ),
      ),
    );

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);

    // The server must actually be consulted (teamId-scoped), not skipped because a
    // localStorage hint already "answered" the question.
    await waitFor(() =>
      expect(mockGetMyPendingDiscordJoin).toHaveBeenCalledWith({ params: { teamId: TEAM_ID } }),
    );

    const link = (await screen.findByRole('link')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://discord.gg/fresh-from-server');
  });

  it('does not clear the stored join when the link is clicked', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(
        Option.some(
          makeStatus({ state: 'ready', discordInviteUrl: Option.some('https://discord.gg/xyz') }),
        ),
      ),
    );

    render(<PendingDiscordJoinBanner teamId={TEAM_ID} />);
    const link = await screen.findByRole('link');
    fireEvent.click(link);

    expect(clearPendingDiscordJoinCalls.length).toBe(0);
  });
});
