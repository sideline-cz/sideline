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
      expect(screen.getByText('discord_connect_regenerate')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('discord_connect_regenerate'));
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
