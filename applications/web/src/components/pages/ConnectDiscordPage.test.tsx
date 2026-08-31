// PR-9 test list items 13-14, plus core state coverage.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Effect, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock('~/lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const { mockGetMyPendingDiscordJoin, mockRegenerateMyDiscordInvite } = vi.hoisted(() => ({
  mockGetMyPendingDiscordJoin: vi.fn(),
  mockRegenerateMyDiscordInvite: vi.fn(),
}));

const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(effect.pipe(Effect.option));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () =>
      Effect.succeed({
        invite: {
          getMyPendingDiscordJoin: mockGetMyPendingDiscordJoin,
          regenerateMyDiscordInvite: mockRegenerateMyDiscordInvite,
        },
      }),
  },
  SilentClientError: class SilentClientError {
    readonly _tag = 'SilentClientError';
  },
  useRun: () => mockRun,
}));

const { ConnectDiscordPage } = await import('./ConnectDiscordPage.js');

const TEAM_ID = 'team-1';
const USER_ID = 'user-1';

describe('ConnectDiscordPage', () => {
  it('test 13 — renders the selectable discord.gg text and a copy button', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(
        Option.some({
          acceptanceId: 'acc-1',
          discordInviteUrl: Option.some('https://discord.gg/abc123'),
          errorCode: Option.none(),
          state: 'ready',
        }),
      ),
    );

    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('https://discord.gg/abc123')).not.toBeNull();
    });
    const linkText = screen.getByText('https://discord.gg/abc123');
    expect(linkText.className).toContain('select-all');
    expect(screen.getByLabelText('discord_copyLinkAria')).not.toBeNull();
  });

  it('test 14 — "Get a new invite" CTA calls regenerateMyDiscordInvite', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(Effect.succeed(Option.none()));
    mockRegenerateMyDiscordInvite.mockReturnValue(
      Effect.succeed(
        Option.some({
          acceptanceId: 'acc-2',
          discordInviteUrl: Option.none(),
          errorCode: Option.none(),
          state: 'preparing',
        }),
      ),
    );

    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('discord_connect_regenerateButton')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('discord_connect_regenerateButton'));
      await Promise.resolve();
    });

    expect(mockRegenerateMyDiscordInvite).toHaveBeenCalledWith({ params: { teamId: TEAM_ID } });
  });

  it('shows loading skeletons before the first response arrives', () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(Effect.never);
    const { container } = render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('clicking Skip for now navigates away and never calls a dismiss/close handler', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(Effect.succeed(Option.none()));
    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );
    await waitFor(() => {
      expect(screen.getByText('discord_connect_skip')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('discord_connect_skip'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: `/teams/${TEAM_ID}` });
  });

  // Blocker 3 (whole-series review, fix/discord-onboarding-webapp): `regenerateMyDiscordInvite`
  // returning `None` because the team has no active invite link at all (a captain-only fix) must
  // not render the same "Get a new invite" copy/CTA as the initial "no acceptance row" state —
  // that CTA returns `None` again on every click, silently, forever. It must render the
  // "ask your captain" copy instead, with no CTA to retry a request that cannot succeed.
  it('shows the "ask your captain" copy, not a repeatable CTA, when regenerate finds no active invite link', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(Effect.succeed(Option.none()));
    mockRegenerateMyDiscordInvite.mockReturnValue(Effect.succeed(Option.none()));

    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('discord_connect_regenerateButton')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('discord_connect_regenerateButton'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('discord_connect_noGuildTitle')).not.toBeNull();
    });
    expect(screen.getByText('discord_connect_noGuildBody')).not.toBeNull();
    expect(screen.queryByText('discord_connect_regenerateButton')).toBeNull();
    expect(screen.queryByText('discord_connect_noLinkTitle')).toBeNull();
  });

  // Should-fix 1 (review of 46806427, fix/discord-onboarding-webapp): `inviteMissing` used to be
  // set only by `handleRegenerate` and never cleared by `fetchStatus`, so once a member hit the
  // "no active invite link" case the "ask your captain" copy stuck for as long as the page stayed
  // mounted — with NO CTA — even while the 10s/focus poll kept running and even after the captain
  // fixed it. The poll must re-arm the CTA so the member can find out the fix landed.
  it('re-arms the regenerate CTA on the next poll, so a captain fixing the invite link is discoverable', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(Effect.succeed(Option.none()));
    mockRegenerateMyDiscordInvite.mockReturnValue(Effect.succeed(Option.none()));

    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('discord_connect_regenerateButton')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('discord_connect_regenerateButton'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('discord_connect_noGuildTitle')).not.toBeNull();
    });
    expect(screen.queryByText('discord_connect_regenerateButton')).toBeNull();

    // The page also re-polls on window focus — cheaper to trigger in a test than the 10s
    // interval, and it is the same `fetchStatus` code path.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('discord_connect_noLinkTitle')).not.toBeNull();
    });
    expect(screen.getByText('discord_connect_regenerateButton')).not.toBeNull();
    expect(screen.queryByText('discord_connect_noGuildTitle')).toBeNull();
  });

  // Case 1 (no acceptance row at all — the ordinary first-visit state) must keep its own copy
  // and CTA and must not be confused with case 3 above.
  it('shows the plain "no invite" copy and CTA on first load, before any regenerate attempt', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(Effect.succeed(Option.none()));

    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('discord_connect_noLinkTitle')).not.toBeNull();
    });
    expect(screen.getByText('discord_connect_regenerateButton')).not.toBeNull();
    expect(screen.queryByText('discord_connect_noGuildTitle')).toBeNull();
  });

  // The `expired` state has its own copy distinct from the `status === null` "no invite" copy —
  // they render identical Alert markup by accident otherwise, even though separate i18n keys
  // exist for exactly this state.
  it('renders the expired-specific copy for an expired invite, not the generic no-invite copy', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(
        Option.some({
          acceptanceId: 'acc-4',
          discordInviteUrl: Option.none(),
          errorCode: Option.none(),
          state: 'expired',
        }),
      ),
    );

    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('discord_connect_expiredTitle')).not.toBeNull();
    });
    expect(screen.getByText('discord_connect_expiredBody')).not.toBeNull();
    expect(screen.getByText('discord_connect_regenerateButton')).not.toBeNull();
    expect(screen.queryByText('discord_connect_noLinkTitle')).toBeNull();
  });

  // BLOCKER (review of 46806427, fix/discord-onboarding-webapp): dropping the SQL filter on
  // `findOpenByUserAndTeam` made the `failed` state reachable again for every error code, but the
  // retry CTA was only rendered when `errorCode` is `None` — which `projectInviteErrorToWire`
  // only produces for `'expired'` (collapsed to the `expired` state, not `failed`, anyway). Every
  // other error code (`bot_missing_perms`, `welcome_channel_deleted`, `bot_not_in_guild`,
  // `unknown`, ...) rendered its explanatory copy with NO way out — the row can't be re-opened by
  // the bot for most codes, and the only thing that creates a fresh row is this CTA. Each error
  // code must render both its specific copy and a working "Try again" CTA.
  describe('failed state renders a working CTA for every error code', () => {
    const cases: ReadonlyArray<{ readonly errorCode: string; readonly expectedCopyKey: string }> = [
      {
        errorCode: 'welcome_channel_missing',
        expectedCopyKey: 'discord_connect_error_captainAction',
      },
      {
        errorCode: 'welcome_channel_deleted',
        expectedCopyKey: 'discord_connect_error_captainAction',
      },
      { errorCode: 'bot_missing_perms', expectedCopyKey: 'discord_connect_error_botPerms' },
      { errorCode: 'bot_not_in_guild', expectedCopyKey: 'discord_connect_error_botPerms' },
      { errorCode: 'rate_limited', expectedCopyKey: 'discord_connect_error_rateLimited' },
      { errorCode: 'unknown', expectedCopyKey: 'discord_connect_error_generic' },
    ];

    for (const { errorCode, expectedCopyKey } of cases) {
      it(`errorCode "${errorCode}" renders its copy plus a retry CTA that calls regenerate`, async () => {
        mockGetMyPendingDiscordJoin.mockReturnValue(
          Effect.succeed(
            Option.some({
              acceptanceId: 'acc-failed',
              discordInviteUrl: Option.none(),
              errorCode: Option.some(errorCode),
              state: 'failed',
            }),
          ),
        );
        mockRegenerateMyDiscordInvite.mockReturnValue(
          Effect.succeed(
            Option.some({
              acceptanceId: 'acc-failed-2',
              discordInviteUrl: Option.none(),
              errorCode: Option.none(),
              state: 'preparing',
            }),
          ),
        );

        render(
          <ConnectDiscordPage
            teamId={TEAM_ID as never}
            teamName='Ultimate Praha'
            userId={USER_ID}
          />,
        );

        await waitFor(() => {
          expect(screen.getByText(expectedCopyKey)).not.toBeNull();
        });
        expect(screen.getByText('discord_connect_retry')).not.toBeNull();

        await act(async () => {
          fireEvent.click(screen.getByText('discord_connect_retry'));
          await Promise.resolve();
        });

        expect(mockRegenerateMyDiscordInvite).toHaveBeenCalledWith({ params: { teamId: TEAM_ID } });
      });
    }

    it('the no-error-code case (e.g. a legacy None row) also renders its copy plus the CTA', async () => {
      mockGetMyPendingDiscordJoin.mockReturnValue(
        Effect.succeed(
          Option.some({
            acceptanceId: 'acc-failed-none',
            discordInviteUrl: Option.none(),
            errorCode: Option.none(),
            state: 'failed',
          }),
        ),
      );

      render(
        <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('discord_connect_error_generic')).not.toBeNull();
      });
      expect(screen.getByText('discord_connect_retry')).not.toBeNull();
    });
  });

  it('renders the success state and a Continue button when state is joined', async () => {
    mockGetMyPendingDiscordJoin.mockReturnValue(
      Effect.succeed(
        Option.some({
          acceptanceId: 'acc-3',
          discordInviteUrl: Option.none(),
          errorCode: Option.none(),
          state: 'joined',
        }),
      ),
    );
    render(
      <ConnectDiscordPage teamId={TEAM_ID as never} teamName='Ultimate Praha' userId={USER_ID} />,
    );
    await waitFor(() => {
      expect(screen.getByText('discord_connect_successTitle')).not.toBeNull();
    });
    expect(screen.getByText('discord_connect_continue')).not.toBeNull();
    // Skip for now must not be shown once already joined.
    expect(screen.queryByText('discord_connect_skip')).toBeNull();
  });
});
