// PR-9 test list item 19 — DiscordConnectCard has no dismiss control. The reporter's original
// complaint was that the old banner could be dismissed and forgotten; the durable replacement
// must never grow the same escape hatch.

import type { Team } from '@sideline/domain';
import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

// Mock TanStack Link to a plain <a> — matches OutstandingPaymentsBanner.test.tsx's precedent.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: React.PropsWithChildren<{ to?: string; params?: Record<string, string> }>) => {
    const href = to
      ? to.replace(/\$(\w+)/g, (_: string, key: string) => params?.[key] ?? key)
      : '#';
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: vi.fn() },
  SilentClientError: class SilentClientError {
    readonly _tag = 'SilentClientError';
  },
  useRun: () => () => async () => {
    throw new Error('not used in this test');
  },
}));

const { DiscordConnectCard } = await import('./DiscordConnectCard.js');

const baseTeam = {
  teamId: 'team-1' as Team.TeamId,
  teamName: 'Ultimate Praha',
  logoUrl: Option.none(),
  roleNames: [],
  permissions: [],
};

describe('DiscordConnectCard', () => {
  it('renders nothing for unknown', () => {
    const { container } = render(
      <DiscordConnectCard team={{ ...baseTeam, discordJoined: 'unknown' }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('has no dismiss control when not_connected', () => {
    render(<DiscordConnectCard team={{ ...baseTeam, discordJoined: 'not_connected' }} />);
    expect(screen.queryByLabelText(/dismiss/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss|close|×/i })).toBeNull();
  });

  it('has no dismiss control when connected', () => {
    render(<DiscordConnectCard team={{ ...baseTeam, discordJoined: 'connected' }} />);
    expect(screen.queryByLabelText(/dismiss/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss|close|×/i })).toBeNull();
  });

  it('shows the amber banner copy and CTA when not_connected', () => {
    render(<DiscordConnectCard team={{ ...baseTeam, discordJoined: 'not_connected' }} />);
    expect(screen.getByText('discord_connect_bannerTitle')).not.toBeNull();
    expect(screen.getByText('discord_connect_bannerCta')).not.toBeNull();
  });

  // Blocker 2 (whole-series review, fix/discord-onboarding-webapp): the server only allows a
  // member to sync `myMemberId === callerMembership.id` (self-serve) without `role:manage`. This
  // component has exactly two callers (`TeamDetailPage`, which passes its OWN dashboard's
  // `myMemberId`, and `MyProfilePage`, which omits it entirely for a cross-team list it has no
  // per-team membership id for) — there is no call site that could pass a DIFFERENT member's id,
  // so `myMemberId !== undefined` is equivalent to "the caller's own row" and needs no additional
  // permission gate here (contrast `PlayerDetailPage`, which renders another member's page and
  // does gate on `canManageRoles`). These pin that the button's visibility is driven purely by
  // whether the caller's own member id is known, matching that contract.
  it('renders the sync button when connected and the caller supplies their own myMemberId', () => {
    render(
      <DiscordConnectCard
        team={{ ...baseTeam, discordJoined: 'connected' }}
        myMemberId={'member-1' as import('@sideline/domain').TeamMember.TeamMemberId}
      />,
    );
    expect(screen.getByRole('button', { name: /discord_syncRolesFor/ })).not.toBeNull();
  });

  it('omits the sync button when connected but no myMemberId is known (e.g. MyProfilePage)', () => {
    render(<DiscordConnectCard team={{ ...baseTeam, discordJoined: 'connected' }} />);
    expect(screen.queryByRole('button', { name: /discord_syncRolesFor/ })).toBeNull();
  });
});
