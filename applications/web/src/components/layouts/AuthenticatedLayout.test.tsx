// PR-9 test list item 22 — AuthenticatedLayout no longer renders PendingDiscordJoinBanner
// (CC-11: the banner is retired, replaced by DiscordConnectCard + the connect-discord
// interstitial + the sidebar badge).

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
  Outlet: () => <div data-testid='outlet' />,
  useMatches: () => [],
  useRouter: () => ({ subscribe: () => () => undefined }),
}));

vi.mock('~/components/layouts/AppSidebar', () => ({
  AppSidebar: () => <div data-testid='app-sidebar' />,
}));

vi.mock('~/components/molecules/PwaInstallPrompt.js', () => ({
  PwaInstallPrompt: () => null,
}));

vi.mock('~/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarInset: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarTrigger: () => <button type='button'>trigger</button>,
  useSidebar: () => ({ setOpenMobile: () => undefined }),
}));

const { AuthenticatedLayout } = await import('./AuthenticatedLayout.js');

const user = {
  id: 'user-1',
  discordId: '1',
  username: 'test',
  avatar: { _tag: 'None' as const },
  isProfileComplete: true,
  name: { _tag: 'None' as const },
  birthDate: { _tag: 'None' as const },
  gender: { _tag: 'None' as const },
  locale: 'en' as const,
  isGlobalAdmin: false,
  displayName: 'Test User',
};

const team = {
  teamId: 'team-1',
  teamName: 'Ultimate Praha',
  logoUrl: { _tag: 'None' as const },
  roleNames: [],
  permissions: [],
  discordJoined: 'not_connected' as const,
};

describe('AuthenticatedLayout', () => {
  it('does not render PendingDiscordJoinBanner (CC-11 — retired)', () => {
    render(
      <AuthenticatedLayout
        user={user as never}
        teams={[team as never]}
        activeTeam={team as never}
        onLogout={() => undefined}
      />,
    );
    // The banner rendered a `role='status'` strip with `invite_joinDiscordBannerDescription` /
    // `discord_connect_*` copy directly under the sidebar; none of it exists anymore, and there
    // is no dismiss-only strip immediately above the outlet.
    expect(screen.queryByText('invite_joinDiscordBannerDescription')).toBeNull();
    expect(screen.getByTestId('outlet')).not.toBeNull();
    expect(screen.getByTestId('app-sidebar')).not.toBeNull();
  });
});
