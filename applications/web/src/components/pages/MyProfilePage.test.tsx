// PR-9 test list item 23 — MyProfilePage renders DiscordConnectCard, not the PR-5 row (CC-11).

import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { back: () => undefined } }),
}));

vi.mock('~/components/organisms/LanguageSwitcher', () => ({
  LanguageSwitcher: () => null,
}));

vi.mock('~/components/organisms/ProfileEditForm', () => ({
  ProfileEditForm: () => null,
}));

const { DiscordConnectCardSpy } = vi.hoisted(() => ({
  DiscordConnectCardSpy: vi.fn((_props: { readonly team: { readonly teamId: string } }) => null),
}));

vi.mock('~/components/organisms/DiscordConnectCard.js', () => ({
  DiscordConnectCard: DiscordConnectCardSpy,
}));

const { MyProfilePage } = await import('./MyProfilePage.js');

const user = {
  id: 'user-1',
  discordId: '1',
  username: 'maxic',
  avatar: Option.none(),
  isProfileComplete: true,
  name: Option.none(),
  birthDate: Option.none(),
  gender: Option.none(),
  locale: 'en' as const,
  isGlobalAdmin: false,
  displayName: 'Maxic',
};

const connectedTeam = {
  teamId: 'team-1',
  teamName: 'Ultimate Praha',
  logoUrl: Option.none(),
  roleNames: [],
  permissions: [],
  discordJoined: 'connected' as const,
};

const unknownTeam = {
  teamId: 'team-2',
  teamName: 'Juniors',
  logoUrl: Option.none(),
  roleNames: [],
  permissions: [],
  discordJoined: 'unknown' as const,
};

describe('MyProfilePage', () => {
  it('renders DiscordConnectCard for each connectable team, not a bespoke row', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never, unknownTeam as never]}
        onUpdated={() => undefined}
      />,
    );

    // Only the non-'unknown' team is passed through — DiscordConnectCard itself decides
    // rendering for 'unknown', but the page filters it out of the section entirely so an
    // all-unknown roster doesn't render an empty card shell.
    expect(DiscordConnectCardSpy).toHaveBeenCalledTimes(1);
    expect(DiscordConnectCardSpy.mock.calls[0]?.[0]).toMatchObject({
      team: expect.objectContaining({ teamId: 'team-1' }),
    });
  });

  it('does not render the retired PR-5 "Join Discord" copy', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never]}
        onUpdated={() => undefined}
      />,
    );
    expect(screen.queryByText('invite_joinDiscordBannerDescription')).toBeNull();
    expect(screen.queryByText('discord_connect_regenerateButton')).toBeNull();
  });

  it('renders nothing extra when every team is unknown', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[unknownTeam as never]}
        onUpdated={() => undefined}
      />,
    );
    expect(DiscordConnectCardSpy).not.toHaveBeenCalled();
  });
});
