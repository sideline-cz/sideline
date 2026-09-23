// `UnsavedChangesGuard` itself is a dumb `{ open, onStay, onLeave }` dialog with no router
// hooks — the `shouldBlockFn` logic it guards lives in `TeamSettingsPage.tsx`, which owns
// `useBlocker`. Both are covered here: the dialog directly, and `shouldBlockFn` by mocking
// `useBlocker` and capturing what `TeamSettingsPage` hands it.

import type { ShouldBlockFn } from '@tanstack/react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

const { UnsavedChangesGuard } = await import('./UnsavedChangesGuard.js');

describe('UnsavedChangesGuard', () => {
  it('renders nothing when closed', () => {
    render(<UnsavedChangesGuard open={false} onStay={() => {}} onLeave={() => {}} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByText('teamSettings_leaveGuard_title')).toBeNull();
  });

  it('renders title and body when open', () => {
    render(<UnsavedChangesGuard open onStay={() => {}} onLeave={() => {}} />);
    expect(screen.getByRole('alertdialog')).not.toBeNull();
    expect(screen.getByText('teamSettings_leaveGuard_title')).not.toBeNull();
    expect(screen.getByText('teamSettings_leaveGuard_body')).not.toBeNull();
  });

  it('Cancel fires onStay', () => {
    const onStay = vi.fn();
    render(<UnsavedChangesGuard open onStay={onStay} onLeave={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'teamSettings_leaveGuard_stay' }));
    // Radix's `AlertDialogCancel` also closes the dialog, which fires `onOpenChange(false)` —
    // this component's own `onOpenChange` calls `onStay` too, so a double call is expected and
    // harmless (the page's `onStay` is `blocker.reset()`, idempotent). What matters is it fires
    // at least once.
    expect(onStay).toHaveBeenCalled();
  });

  it('the destructive action fires onLeave', () => {
    const onLeave = vi.fn();
    render(<UnsavedChangesGuard open onStay={() => {}} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: 'teamSettings_leaveGuard_leave' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// `shouldBlockFn` — lives in `TeamSettingsPage.tsx`, reachable only by mounting the page and
// inspecting what it hands `useBlocker`.
// ---------------------------------------------------------------------------

interface CapturedBlockerOptions {
  readonly shouldBlockFn: ShouldBlockFn;
  readonly enableBeforeUnload: () => boolean;
  readonly withResolver: boolean;
}

const { useBlockerSpy } = vi.hoisted(() => ({
  useBlockerSpy: vi.fn((_options: CapturedBlockerOptions) => ({ status: 'idle' as const })),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  useBlocker: useBlockerSpy,
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

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

const { TeamSettingsPage } = await import('../../pages/TeamSettingsPage.js');

type Props = React.ComponentProps<typeof TeamSettingsPage>;

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

function renderPage() {
  const props = {
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
  } as unknown as Props;
  return render(<TeamSettingsPage {...props} />);
}

const dirtyHorizonDays = () => {
  const horizon = screen.getByLabelText('teamSettings_horizonDays') as HTMLInputElement;
  fireEvent.change(horizon, { target: { value: '99' } });
};

const location = (pathname: string, tab: string) =>
  ({
    pathname,
    search: { tab },
    routeId: '/(authenticated)/teams/$teamId/settings',
    fullPath: '/teams/$teamId/settings',
    params: { teamId: 'team-1' },
  }) as never;

const lastBlockerCall = (): CapturedBlockerOptions => {
  const last = useBlockerSpy.mock.calls.at(-1);
  if (!last) throw new Error('useBlocker was never called');
  return last[0];
};

describe("TeamSettingsPage's shouldBlockFn", () => {
  const latestShouldBlockFn = (): ShouldBlockFn => lastBlockerCall().shouldBlockFn;

  it('returns false when only the search param changed, even while dirty', () => {
    renderPage();
    dirtyHorizonDays();

    const result = latestShouldBlockFn()({
      current: location('/teams/t1/settings', 'general'),
      next: location('/teams/t1/settings', 'discord'),
    } as never);

    expect(result).toBe(false);
  });

  it('returns true when the pathname changes and something is dirty', () => {
    renderPage();
    dirtyHorizonDays();

    const result = latestShouldBlockFn()({
      current: location('/teams/t1/settings', 'general'),
      next: location('/teams/t1', 'general'),
    } as never);

    expect(result).toBe(true);
  });

  it('returns false when nothing is dirty', () => {
    renderPage();

    const result = latestShouldBlockFn()({
      current: location('/teams/t1/settings', 'general'),
      next: location('/teams/t1', 'general'),
    } as never);

    expect(result).toBe(false);
  });

  it('useBlocker is not re-subscribed on every render', () => {
    renderPage();
    const firstCall = useBlockerSpy.mock.calls[0];
    if (!firstCall) throw new Error('useBlocker was never called');
    const firstShouldBlockFn = firstCall[0].shouldBlockFn;

    const horizon = screen.getByLabelText('teamSettings_horizonDays') as HTMLInputElement;
    fireEvent.change(horizon, { target: { value: '31' } });
    fireEvent.change(horizon, { target: { value: '32' } });
    fireEvent.change(horizon, { target: { value: '33' } });

    // Sanity: the page really did re-render several times over those edits.
    expect(useBlockerSpy.mock.calls.length).toBeGreaterThan(1);

    for (const call of useBlockerSpy.mock.calls) {
      expect(call[0].shouldBlockFn).toBe(firstShouldBlockFn);
    }
  });
});
