// Discord moved off the sidebar onto the profile page: no nav entry any more, and the
// "needs attention" dot rides on NavUser's Profile item instead. AppSidebar owns the mapping from
// `discordJoined` to that dot — 'unknown' (join enforcement off) must never raise it.
import { render, screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));

const navUserProps = vi.fn();
vi.mock('~/components/layouts/NavUser', () => ({
  NavUser: (props: { discordNeedsAttention?: boolean }) => {
    navUserProps(props);
    return null;
  },
}));
vi.mock('~/components/layouts/TeamSwitcher', () => ({ TeamSwitcher: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: React.PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a>,
  useMatchRoute: () => () => false,
}));

const Pass = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
vi.mock('~/components/ui/sidebar', () => ({
  Sidebar: Pass,
  SidebarContent: Pass,
  SidebarFooter: Pass,
  SidebarGroup: Pass,
  SidebarGroupContent: Pass,
  SidebarGroupLabel: Pass,
  SidebarHeader: Pass,
  SidebarMenu: Pass,
  SidebarMenuButton: Pass,
  SidebarMenuItem: Pass,
  SidebarRail: () => null,
}));

const { AppSidebar } = await import('~/components/layouts/AppSidebar.js');

const renderWith = (discordJoined: 'connected' | 'not_connected' | 'unknown') =>
  render(
    <AppSidebar
      user={{ isGlobalAdmin: false } as never}
      teams={[]}
      activeTeam={{ teamId: 'team-1', permissions: [], discordJoined } as never}
      onLogout={vi.fn()}
    />,
  );

describe('AppSidebar — Discord', () => {
  it.each([
    ['not_connected', true],
    ['connected', false],
    ['unknown', false],
  ] as const)('discordJoined=%s → NavUser dot %s', (state, expected) => {
    renderWith(state);
    expect(navUserProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ discordNeedsAttention: expected }),
    );
  });

  it('has no Discord nav entry and no dot in the nav list', () => {
    renderWith('not_connected');
    expect(document.querySelector('a[href="/teams/$teamId/connect-discord"]')).toBeNull();
    expect(screen.queryByText('discord_navTitle')).toBeNull();
    expect(screen.queryByText('discord_navNeedsAttention')).toBeNull();
  });
});
