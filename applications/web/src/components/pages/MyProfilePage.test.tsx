// PR-9 test list item 23 — MyProfilePage renders DiscordConnectCard, not the PR-5 row (CC-11).
// Nastavitelná docházka (design.md §A.1, plan §10.3) — EXTENDED: MyProfilePage also renders a
// local EventPreferencesSection({ teams, prefs, onRefresh }) next to DiscordConnectSection,
// filtered on the POSITIVE literal `discordJoined === 'connected'` — a DIFFERENT predicate than
// DiscordConnectSection's `!== 'unknown'` (design.md §A.1's correction: a member who is not in
// the guild has no personal channel and receives no DM, so every control would be inert).

import { fireEvent, render, screen } from '@testing-library/react';
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

const { DiscordConnectCardSpy, EventPreferencesCardSpy, EventPreferencesLoadFailedSpy } =
  vi.hoisted(() => ({
    DiscordConnectCardSpy: vi.fn((_props: { readonly team: { readonly teamId: string } }) => null),
    EventPreferencesCardSpy: vi.fn((_props: { readonly teamId: string }) => null),
    EventPreferencesLoadFailedSpy: vi.fn(() => null),
  }));

vi.mock('~/components/organisms/DiscordConnectCard.js', () => ({
  DiscordConnectCard: DiscordConnectCardSpy,
}));

vi.mock('~/components/organisms/EventPreferencesCard.js', () => ({
  EventPreferencesCard: EventPreferencesCardSpy,
  EventPreferencesLoadFailed: EventPreferencesLoadFailedSpy,
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

const notConnectedTeam = {
  teamId: 'team-3',
  teamName: 'Masters',
  logoUrl: Option.none(),
  roleNames: [],
  permissions: [],
  discordJoined: 'not_connected' as const,
};

// EventPreferencesSection renders `EventPreferencesLoadFailed` — a DIFFERENT component — for a
// team whose preferences are absent, so an empty map is NOT a neutral default: it would route
// every team down the failure path. Supply real prefs for every team id used in this file.
const basePrefs = {
  showAttendeeList: true,
  rsvpReminderDms: true,
  personalChannelsSplit: false,
  personalChannelsAvailable: true,
};
const noPrefs = Object.fromEntries(
  ['team-1', 'team-2', 'team-3', 'team-4'].map((id) => [id, basePrefs]),
);
const onRefresh = () => undefined;

describe('MyProfilePage', () => {
  it('renders DiscordConnectCard for each connectable team, not a bespoke row', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never, unknownTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
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
        prefs={noPrefs as never}
        onRefresh={onRefresh}
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
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );
    expect(DiscordConnectCardSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Nastavitelná docházka (design.md §A.1, plan §10.3): EventPreferencesSection
// filtering — one card per team with discordJoined === 'connected'; none for
// 'not_connected' or 'unknown'; renders null (no EventPreferencesCard calls)
// when no team qualifies.
// ---------------------------------------------------------------------------

describe('MyProfilePage — EventPreferencesSection filtering (design.md §A.1)', () => {
  it('renders one EventPreferencesCard per team with discordJoined === "connected"', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never, unknownTeam as never, notConnectedTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );

    expect(EventPreferencesCardSpy).toHaveBeenCalledTimes(1);
    expect(EventPreferencesCardSpy.mock.calls[0]?.[0]).toMatchObject({ teamId: 'team-1' });
  });

  it('does NOT render a card for "not_connected" — unlike DiscordConnectSection, which explicitly targets that state', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[notConnectedTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );

    expect(EventPreferencesCardSpy).not.toHaveBeenCalled();
    // The DiscordConnectSection DOES render for not_connected — confirms the two
    // sections use genuinely different predicates, not a shared filter.
    expect(DiscordConnectCardSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT render a card for "unknown"', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[unknownTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );

    expect(EventPreferencesCardSpy).not.toHaveBeenCalled();
  });

  it('a team whose preferences failed to load gets EventPreferencesLoadFailed, never the card', () => {
    // The two are DIFFERENT components on purpose: `useCardForm` seeds its state once, so a
    // card mounted against a failed load would keep those defaults after a successful retry
    // and arm Save to overwrite the member's real settings.
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never]}
        onUpdated={() => undefined}
        prefs={{} as never}
        onRefresh={onRefresh}
      />,
    );

    expect(EventPreferencesCardSpy).not.toHaveBeenCalled();
    expect(EventPreferencesLoadFailedSpy).toHaveBeenCalledTimes(1);
  });

  it('renders nothing from the section when no team is connected', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[unknownTeam as never, notConnectedTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );

    expect(EventPreferencesCardSpy).not.toHaveBeenCalled();
  });

  it('multiple connected teams → ONE card plus a named switcher, not N identical cards', () => {
    const secondConnectedTeam = { ...connectedTeam, teamId: 'team-4', teamName: 'Seniors' };
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never, secondConnectedTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );

    // Exactly one card — N identical cards left a multi-team member unable to tell which
    // card belonged to which team, since the card names the feature and never the team.
    expect(EventPreferencesCardSpy).toHaveBeenCalledTimes(1);
    expect(
      (EventPreferencesCardSpy.mock.calls[0]?.[0] as { teamId: string } | undefined)?.teamId,
    ).toBe('team-1');

    // The switcher names every team, so the choice is visible rather than implied.
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent).sort()).toEqual(['Seniors', 'Ultimate Praha']);
  });

  it('switching team swaps the card and remounts it (fresh form state per team)', () => {
    const secondConnectedTeam = { ...connectedTeam, teamId: 'team-4', teamName: 'Seniors' };
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never, secondConnectedTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Seniors' }));

    const last = EventPreferencesCardSpy.mock.calls.at(-1)?.[0] as any;
    expect(last.teamId).toBe('team-4');
    // Regression guard: the card is keyed by teamId, so React remounts it and `useCardForm`
    // reseeds. Without that, one team's unsaved edits ride onto another team's baseline and
    // Save would write them to the wrong team.
    expect(EventPreferencesCardSpy).toHaveBeenCalledTimes(2);
  });

  it('a single connected team renders no switcher', () => {
    render(
      <MyProfilePage
        user={user as never}
        teams={[connectedTeam as never]}
        onUpdated={() => undefined}
        prefs={noPrefs as never}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(EventPreferencesCardSpy).toHaveBeenCalledTimes(1);
  });
});
