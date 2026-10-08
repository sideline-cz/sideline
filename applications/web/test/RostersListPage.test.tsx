import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      roster_rosters: 'Rosters',
      roster_noRosters: 'No rosters yet.',
      list_filter_active: 'Active only',
      list_filter_all: 'All',
      list_noMatches: 'Nothing matches your search or filter.',
      list_sortLabel: 'Sort',
      list_sort_name: 'Name',
      list_sort_status: 'Status',
      roster_searchPlaceholder: 'Search rosters',
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

describe('RostersListPage — active/inactive filter', () => {
  it('hides inactive rosters until the All chip is selected', () => {
    renderPage();

    expect(screen.queryByText('Alpha')).not.toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.queryByText('Alpha')).not.toBeNull();
    expect(screen.queryByText('Archived')).not.toBeNull();
  });

  it('defaults to Active only, so the chip reflects what is on screen', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Active only' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('says nothing matches — not "no rosters yet" — when every roster is inactive', () => {
    render(
      <RostersListPage
        teamId='team-1'
        rosters={[roster('Archived', false)]}
        canManage={false}
        userId='u-1'
      />,
    );

    // The team HAS a roster; it is only filtered out. Claiming "No rosters yet." here sent the
    // reader off to create one they already had.
    expect(screen.queryByText('No rosters yet.')).toBeNull();
    expect(screen.queryByText('Nothing matches your search or filter.')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.queryByText('Nothing matches your search or filter.')).toBeNull();
    expect(screen.queryByText('Archived')).not.toBeNull();
  });

  it('still shows the real empty state when the team genuinely has no rosters', () => {
    render(<RostersListPage teamId='team-1' rosters={[]} canManage={false} userId='u-1' />);
    expect(screen.queryByText('No rosters yet.')).not.toBeNull();
  });

  it('filters by name, keeping the active-only filter applied', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Search rosters'), {
      target: { value: 'arch' },
    });
    // 'Archived' matches the query but is inactive, and the default chip is "Active only".
    expect(screen.queryByText('Archived')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.queryByText('Archived')).not.toBeNull();
    expect(screen.queryByText('Alpha')).toBeNull();
  });
});
