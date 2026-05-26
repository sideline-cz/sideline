// Tests for NoTeamPage component.
//
// Component contract:
//   NoTeamPage({ justRemoved?: boolean, onLogout?: () => void })
//   - Renders a page with noTeam_title heading
//   - Renders noTeam_description paragraph
//   - Renders "You're no longer a member of your team." banner when justRemoved is true
//   - Does NOT render the banner when justRemoved is undefined or false
//   - Sign-out button click triggers logout action (calls onLogout prop)

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock the tr() helper used by the component
vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      app_name: 'Sideline',
      noTeam_pageTitle: 'No team',
      noTeam_title: "You're not on a team yet",
      noTeam_description:
        'Teams are set up by your captain or coach. Contact them to be added to a team.',
      noTeam_removedBanner: "You're no longer a member of your team.",
      nav_logOut: 'Sign out',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// Mock LanguageSwitcher organism to avoid its dependencies
vi.mock('~/components/organisms/LanguageSwitcher.js', () => ({
  LanguageSwitcher: ({ isAuthenticated }: { isAuthenticated?: boolean }) => (
    <div data-testid='language-switcher' data-authenticated={isAuthenticated} />
  ),
}));

// Dynamic import AFTER mocks are set up
const { NoTeamPage } = await import('~/components/pages/NoTeamPage.js');

describe('NoTeamPage', () => {
  it('renders noTeam_title heading', () => {
    render(<NoTeamPage />);
    const heading = screen.getByRole('heading', { name: /You're not on a team yet/i });
    expect(heading).not.toBeNull();
  });

  it('renders noTeam_description paragraph', () => {
    render(<NoTeamPage />);
    expect(screen.getByText(/Teams are set up by your captain or coach/i)).not.toBeNull();
  });

  it('renders removal banner when justRemoved is true', () => {
    render(<NoTeamPage justRemoved={true} />);
    expect(screen.getByText(/You're no longer a member of your team/i)).not.toBeNull();
  });

  it('does NOT render the banner when justRemoved is undefined', () => {
    render(<NoTeamPage />);
    expect(screen.queryByText(/no longer a member/i)).toBeNull();
  });

  it('does NOT render the banner when justRemoved is false', () => {
    render(<NoTeamPage justRemoved={false} />);
    expect(screen.queryByText(/no longer a member/i)).toBeNull();
  });

  it('sign-out button is rendered', () => {
    render(<NoTeamPage />);
    const btn = screen.getByRole('button', { name: /Sign out/i });
    expect(btn).not.toBeNull();
  });

  it('sign-out button click triggers onLogout prop', () => {
    const onLogout = vi.fn();
    render(<NoTeamPage onLogout={onLogout} />);
    const btn = screen.getByRole('button', { name: /Sign out/i });
    fireEvent.click(btn);
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
