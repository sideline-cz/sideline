// TeamSettingsPage — the six-tab redesign. `TeamSettingsSection` is gone: the four cards saved
// by `updateTeamSettings` now share one `useTeamSettingsForm` hoisted ABOVE the tabs so a tab
// switch (general/discord) can never unmount it, and every card (shared or not) registers with
// the page-level `SaveBar` instead of owning its own inline Save button.
//
// This suite never clicks Save — `useTeamSettingsForm`'s and each card's own save/discard wiring
// already have coverage elsewhere (or is exercised through the mocked `~/lib/runtime` throwing if
// a card ever DOES try to call it, which is the point: no card may fire a request just from being
// rendered or from a tab switch).
//
// jsdom loads no stylesheet in this repo's test setup (`vitest.config.ts` has no CSS handling,
// and `@testing-library/jest-dom` is not a dependency), so `data-[state=inactive]:hidden` — the
// Tailwind rule that actually hides a force-mounted inactive panel in a browser — has no effect
// here and `toBeVisible()` isn't even a registered matcher. The real, checkable signal in this
// environment is the `data-state` Radix puts on the ancestor `[role="tabpanel"]` element (the
// same signal `DashboardCustomizer.test.tsx` reads off Switches elsewhere in this suite), so
// `panelState()` below reads that instead of asserting on CSS-driven visibility.

import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  useBlocker: () => ({ status: 'idle' as const }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

// No card in this page may fire a request just from rendering, a tab switch, or an edit — only a
// Save click may reach the API, and this suite never clicks Save. Throwing here turns any
// accidental call into a loud test failure instead of a silent network mock.
vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () => {
      throw new Error('no card should call the API in this suite');
    },
  },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError' as const, message }) },
  useRun: () => () => {
    throw new Error('no card should call run() in this suite');
  },
}));

const { TeamSettingsPage } = await import('./TeamSettingsPage.js');

type Props = React.ComponentProps<typeof TeamSettingsPage>;

// ---------------------------------------------------------------------------
// Fixtures — plain objects, not `Schema.decodeSync`'d instances. Nothing under
// test decodes these; every card reads plain fields (including real `effect`
// `Option`s, since `selectValue`/`Option.getOrElse` are called on them).
// ---------------------------------------------------------------------------

const baseSettings = {
  teamId: 'team-1',
  eventHorizonDays: 30,
  minPlayersThreshold: 8,
  rsvpRemindersEnabled: true,
  requireCompleteProfile: false,
  rsvpReminderDaysBefore: 2,
  rsvpReminderDaysBeforeOverrides: {},
  maxMissedRsvps: 3,
  claimRequestDaysBefore: 5,
  rsvpReminderTime: '18:00',
  remindersChannelId: Option.none(),
  timezone: 'Europe/Prague',
  discordChannelLateRsvp: Option.none(),
  createDiscordChannelOnGroup: false,
  createDiscordChannelOnRoster: false,
  discordArchiveCategoryId: Option.none(),
  discordRosterCategoryId: Option.none(),
  discordPersonalEventsCategoryId: Option.none(),
  discordPersonalEventsGroupId: Option.none(),
  discordPersonalEventsChannelFormat: 'events-{discord_id}',
  discordEventsChannelId: Option.none(),
  discordChannelCleanupOnGroupDelete: 'nothing',
  discordChannelCleanupOnRosterDeactivate: 'nothing',
  discordRoleFormat: '{emoji} {name}',
  discordChannelFormat: '{emoji}│{name}',
  rulesQuizChannelId: Option.none(),
  rulesQuizIntervalDays: 7,
  rulesQuizTime: '18:00',
};

const baseTeamInfo = {
  teamId: 'team-1',
  name: 'Sharks',
  description: Option.none(),
  sport: Option.none(),
  logoUrl: Option.none(),
  guildId: '1',
  welcomeChannelId: Option.none(),
  systemLogChannelId: Option.none(),
  welcomeMessageTemplate: Option.none(),
  verifyIntroTemplate: Option.none(),
  rulesChannelId: Option.none(),
  achievementChannelId: Option.none(),
  onboardingRulesRoleId: Option.none(),
  onboardingLocale: 'en' as const,
  onboardingSyncStatus: 'done' as const,
  onboardingSyncedAt: Option.none(),
  onboardingSyncError: Option.none(),
  isCommunityEnabled: true,
};

const defaultProps = () => ({
  teamId: 'team-1',
  settings: { ...baseSettings },
  discordChannels: [],
  discordRoles: [],
  groups: [],
  teamInfo: { ...baseTeamInfo },
  emailForwardingConfig: null,
  initialGenerationConfig: null,
  bankSyncConfig: null,
  canManageBankSync: false,
});

// `overrides` is deliberately untyped against `Props` — several tests below override with a
// plain fixture object (not a decoded `Schema.Class` instance), same convention as
// `MyProfilePage.test.tsx`'s `as never` casts.
function renderPage(overrides: Record<string, unknown> = {}) {
  const props = { ...defaultProps(), ...overrides } as unknown as Props;
  return render(<TeamSettingsPage {...props} />);
}

/** The `data-state` Radix puts on the ancestor tabpanel: 'active' | 'inactive' | null. */
const panelState = (el: HTMLElement) => el.closest('[role="tabpanel"]')?.getAttribute('data-state');

/** Radix's `TabsTrigger` switches tabs on `mousedown` (see `onMouseDown` in
 * `@radix-ui/react-tabs`), not `click` — `fireEvent.click` alone never fires it. */
const clickTab = (name: string) =>
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });

describe('TeamSettingsPage', () => {
  it("renders only the General cards' fields visibly by default", () => {
    renderPage();

    const horizon = screen.getByLabelText('teamSettings_horizonDays');
    const claimDays = screen.getByLabelText('teamSettings_claimRequestDaysBefore');
    expect(panelState(horizon)).toBe('active');
    expect(panelState(claimDays)).toBe('active');

    // Force-mounted, present in the DOM, but their panel is inactive.
    const discordSwitch = screen.getByLabelText('teamSettings_createDiscordChannelOnGroup');
    expect(panelState(discordSwitch)).toBe('inactive');

    const emailSwitch = screen.getByLabelText('team_email_forwarding_enabled_label');
    expect(panelState(emailSwitch)).toBe('inactive');
  });

  it('hides the Finance tab when canManageBankSync is false', () => {
    renderPage({ canManageBankSync: false });
    expect(screen.queryByRole('tab', { name: 'teamSettings_tab_finance' })).toBeNull();
  });

  it('hides the Automation tab when there is no generation config to manage', () => {
    renderPage({ initialGenerationConfig: null });
    expect(screen.queryByRole('tab', { name: 'teamSettings_tab_automation' })).toBeNull();
  });

  it('hides the Automation tab when canManage is false', () => {
    renderPage({
      initialGenerationConfig: {
        teamId: 'team-1',
        weightElo: 50,
        weightSize: 25,
        weightGender: 25,
        defaultTeamCount: 2,
        maxIterations: 500,
        canManage: false,
      },
    });
    expect(screen.queryByRole('tab', { name: 'teamSettings_tab_automation' })).toBeNull();
  });

  it('a requested tab the user cannot see falls back to General', () => {
    // `activeTab` alone (no `onTabChange`) does not put the page in controlled mode — see
    // `isControlled` in `TeamSettingsPage.tsx` — so an unreachable requested tab is simply
    // ignored rather than crashing or hiding General. The route pairs `activeTab` with
    // `onTabChange` and is what actually applies the finance/automation fallback before handing
    // the tab to this component.
    renderPage({ activeTab: 'finance', canManageBankSync: false });
    const horizon = screen.getByLabelText('teamSettings_horizonDays');
    expect(panelState(horizon)).toBe('active');
  });

  it('an edit on General survives a switch to Discord and back', () => {
    renderPage();

    const horizon = screen.getByLabelText('teamSettings_horizonDays') as HTMLInputElement;
    fireEvent.change(horizon, { target: { value: '45' } });
    expect(horizon.value).toBe('45');

    clickTab('teamSettings_tab_discord');
    const discordSwitch = screen.getByLabelText('teamSettings_createDiscordChannelOnGroup');
    expect(panelState(discordSwitch)).toBe('active');

    clickTab('teamSettings_tab_general');
    const horizonAgain = screen.getByLabelText('teamSettings_horizonDays') as HTMLInputElement;
    expect(horizonAgain.value).toBe('45');
  });

  it('the four shared-payload cards produce exactly one save-bar row', () => {
    renderPage();

    const horizon = screen.getByLabelText('teamSettings_horizonDays') as HTMLInputElement;
    fireEvent.change(horizon, { target: { value: '45' } });

    clickTab('teamSettings_tab_discord');
    const roleFormat = screen.getByDisplayValue('{emoji} {name}') as HTMLInputElement;
    fireEvent.change(roleFormat, { target: { value: '{name}' } });

    const rows = screen.getAllByText(/^teamSettings_saveBar_dirtyIn:/);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('teamSettings_saveBar_settingsGroup');
  });

  it('editing a field on a hidden tab keeps its row in the bar', () => {
    renderPage();

    clickTab('teamSettings_tab_email');
    const emailSwitch = screen.getByLabelText('team_email_forwarding_enabled_label');
    fireEvent.click(emailSwitch);

    clickTab('teamSettings_tab_general');

    const row = screen.getByText(/^teamSettings_saveBar_dirtyIn:/);
    expect(row.textContent).toContain('team_email_forwarding_title');

    const saveButton = screen.getByRole('button', {
      name: 'teamSettings_saveBar_saveAria:{"form":"team_email_forwarding_title"}',
    });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('the bar is absent when nothing is dirty', () => {
    renderPage();
    expect(screen.queryByText(/^teamSettings_saveBar_dirtyIn:/)).toBeNull();
    expect(screen.queryByRole('button', { name: /teamSettings_saveBar_saveAria/ })).toBeNull();
  });

  it('Discard resets only its own form', () => {
    renderPage();

    const teamName = screen.getByLabelText('teamSettings_teamName') as HTMLInputElement;
    fireEvent.change(teamName, { target: { value: 'New Name' } });

    const horizon = screen.getByLabelText('teamSettings_horizonDays') as HTMLInputElement;
    fireEvent.change(horizon, { target: { value: '45' } });

    const profileDiscard = screen.getByRole('button', {
      name: 'teamSettings_saveBar_discardAria:{"form":"teamSettings_teamProfile"}',
    });
    fireEvent.click(profileDiscard);

    expect(teamName.value).toBe('Sharks');
    expect(horizon.value).toBe('45');
    expect(
      screen.getByRole('button', {
        name: 'teamSettings_saveBar_saveAria:{"form":"teamSettings_saveBar_settingsGroup"}',
      }),
    ).not.toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'teamSettings_saveBar_saveAria:{"form":"teamSettings_teamProfile"}',
      }),
    ).toBeNull();
  });

  it("a card's disabled reason reaches the bar", () => {
    renderPage({ teamInfo: { ...baseTeamInfo, isCommunityEnabled: false } });

    clickTab('teamSettings_tab_onboarding');
    // jsdom does not suppress a synthetic click on a control inside a `disabled` `<fieldset>`
    // (a real browser would), so this reaches the locale ToggleGroup's handler and dirties the
    // form even though the card's own inputs are rendered disabled for real users.
    fireEvent.click(screen.getByLabelText('teamSettings_onboardingLocaleCs'));

    const saveButton = screen.getByRole('button', {
      name: 'teamSettings_saveBar_saveAria:{"form":"teamSettings_onboardingTitle"}',
    });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onTabChange with the tab id when controlled', () => {
    const onTabChange = vi.fn();
    renderPage({ activeTab: 'general', onTabChange });

    clickTab('teamSettings_tab_email');
    expect(onTabChange).toHaveBeenCalledWith('email');
  });
});
