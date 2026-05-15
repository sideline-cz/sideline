import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import pkg from '../../../package.json' with { type: 'json' };

const EXPECTED_WEB_VERSION = pkg.version;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Stub translations — return the key as the text
vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      nav_logOut: 'Log out',
      nav_profile: 'Profile',
      nav_notifications: 'Notifications',
      nav_documentation: 'Documentation',
      nav_reportBug: 'Report bug',
      language_label: 'Language',
      theme_label: 'Theme',
      language_en: 'English',
      language_cs: 'Czech',
      theme_light: 'Light',
      theme_dark: 'Dark',
      theme_system: 'System',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// Stub i18n runtime
vi.mock('@sideline/i18n/runtime', () => ({
  getLocale: () => 'en',
  setLocale: vi.fn(),
}));

// Stub router (NavUser uses Link)
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

// Stub useSidebar (from sidebar ui component)
vi.mock('~/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarMenuButton: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button {...props}>{children}</button>
  ),
  useSidebar: () => ({ isMobile: false }),
}));

// Stub useTheme
vi.mock('~/lib/theme.js', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

// Stub useRun (effect runtime hook)
vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () => ({ pipe: () => {} }),
  },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  useRun: () => () => () => Promise.resolve(undefined),
}));

// ---------------------------------------------------------------------------
// Helper: wrap with QueryClientProvider
// ---------------------------------------------------------------------------

function withQueryClient(ui: React.ReactElement, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// ---------------------------------------------------------------------------
// Minimal user fixture
// ---------------------------------------------------------------------------

const { Option } = await import('effect');

const mockUser = {
  id: 'user-id',
  discordId: 'discord-id',
  username: 'testuser',
  name: Option.some('Test User'),
  avatar: Option.none(),
  locale: Option.some('en' as const),
};

// ---------------------------------------------------------------------------
// NavUser import (will fail until the component exists with version support)
// ---------------------------------------------------------------------------

const { NavUser } = await import('~/components/layouts/NavUser.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NavUser — version display', () => {
  it('renders all three version lines with the static web version and fetched server+bot when query resolves', async () => {
    // Pre-populate the query cache so useQuery resolves immediately
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['versions'], { server: '0.18.0', bot: '0.13.0' });

    withQueryClient(
      <NavUser user={mockUser as never} activeTeamId={undefined} onLogout={vi.fn()} />,
      queryClient,
    );

    // Web version (static from package.json)
    const webVersionPattern = new RegExp(
      `Web.*${EXPECTED_WEB_VERSION}|${EXPECTED_WEB_VERSION}.*Web`,
    );
    expect(screen.getByText(webVersionPattern)).not.toBeNull();

    // Server version (from query data)
    expect(screen.getByText(/Server.*0\.18\.0|0\.18\.0.*Server/)).not.toBeNull();

    // Bot version (from query data)
    expect(screen.getByText(/Bot.*0\.13\.0|0\.13\.0.*Bot/)).not.toBeNull();
  });

  it('renders em-dashes for server and bot while query is loading', async () => {
    // Do NOT pre-populate cache — let it stay in loading state
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    withQueryClient(
      <NavUser user={mockUser as never} activeTeamId={undefined} onLogout={vi.fn()} />,
      queryClient,
    );

    // While loading: em-dash placeholders for server and bot
    const allText = document.body.textContent ?? '';
    // Should contain at least two em-dashes (server + bot)
    const emDashCount = (allText.match(/—/g) ?? []).length;
    expect(emDashCount).toBeGreaterThanOrEqual(2);

    // Web version is always shown (static)
    expect(allText).toContain(EXPECTED_WEB_VERSION);
  });

  it('versions section is positioned above the Log out item in the dropdown', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['versions'], { server: '0.18.0', bot: '0.13.0' });

    withQueryClient(
      <NavUser user={mockUser as never} activeTeamId={undefined} onLogout={vi.fn()} />,
      queryClient,
    );

    // Get all text nodes in document order
    const body = document.body;
    const allText = body.textContent ?? '';

    // "0.18.0" (server version) must appear before "Log out" in DOM order
    const serverVersionIdx = allText.indexOf('0.18.0');
    const logOutIdx = allText.indexOf('Log out');

    expect(serverVersionIdx).toBeGreaterThan(-1);
    expect(logOutIdx).toBeGreaterThan(-1);
    expect(serverVersionIdx).toBeLessThan(logOutIdx);
  });
});
