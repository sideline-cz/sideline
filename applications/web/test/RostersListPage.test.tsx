import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      roster_rosters: 'Rosters',
      roster_noRosters: 'No rosters yet.',
      roster_showInactive: 'Show inactive rosters',
      roster_active: 'Active',
      roster_inactive: 'Inactive',
      team_backToTeams: 'Back',
    };
    if (key === 'roster_memberCount') return `${String(params?.count)} members`;
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: vi.fn(() => ({ pipe: vi.fn() })) },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  useRun: vi.fn(() => vi.fn(() => new Promise(() => {}))),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

const { RostersListPage } = await import('~/components/pages/RostersListPage.js');

function roster(name: string, active: boolean) {
  return {
    rosterId: `r-${name}`,
    teamId: 'team-1',
    name,
    active,
    memberCount: 3,
    createdAt: '2026-01-01T00:00:00Z',
    color: Option.none<string>(),
    emoji: Option.none<string>(),
    discordChannelId: Option.none<string>(),
    discordChannelName: Option.none<string>(),
    discordChannelProvisioning: false,
  } as any;
}

const ROSTERS = [roster('Alpha', true), roster('Archived', false)];

function renderPage() {
  return render(
    <RostersListPage teamId='team-1' rosters={ROSTERS} canManage={false} userId='u-1' />,
  );
}

describe('RostersListPage — active/inactive toggle', () => {
  it('hides inactive rosters until the toggle is switched on', () => {
    renderPage();

    expect(screen.queryByText('Alpha')).not.toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Show inactive rosters' }));

    expect(screen.queryByText('Alpha')).not.toBeNull();
    expect(screen.queryByText('Archived')).not.toBeNull();
  });

  it('shows the empty state — with the toggle still reachable — when every roster is inactive', () => {
    render(
      <RostersListPage
        teamId='team-1'
        rosters={[roster('Archived', false)]}
        canManage={false}
        userId='u-1'
      />,
    );

    expect(screen.queryByText('No rosters yet.')).not.toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Show inactive rosters' }));

    expect(screen.queryByText('No rosters yet.')).toBeNull();
    expect(screen.queryByText('Archived')).not.toBeNull();
  });
});
