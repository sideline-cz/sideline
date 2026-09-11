// Sibling of TeamDetailPage.test.tsx (plan §7.8 PR 5, item 3) — pins the runtime
// timezone to Pacific/Auckland (UTC+12/+13) BEFORE the component under test is
// imported. This is the timezone that would expose a bug if the all-day date badge
// or the "Dnes"/"Zítra" relative label ever read a *local* Date part off an instant
// instead of the server-derived `YYYY-MM-DD` strings (`event.startDate` /
// `dashboard.todayLocalDate`): under the old (buggy) local read, a 2026-07-15
// UTC-midnight-team-local instant would render as the 16th in Auckland. If this
// file's assertions ever start failing while the sibling `TeamDetailPage.test.tsx`
// (pinned to Europe/Prague) keeps passing, that is exactly this regression.
process.env.TZ = 'Pacific/Auckland';

import { render, screen } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      dashboard_title: 'Dashboard',
      dashboard_today: 'Today',
      dashboard_tomorrow: 'Tomorrow',
      dashboard_awaitingRsvp: 'Awaiting RSVP',
      dashboard_rsvpNow: 'RSVP now',
      dashboard_upcomingEvents: 'Upcoming events',
      dashboard_viewEvents: 'View events',
      dashboard_noUpcomingEvents: 'No upcoming events',
      dashboard_activitySummary: 'Activity summary',
      dashboard_viewLeaderboard: 'View leaderboard',
      dashboard_teamManagement: 'Team management',
      dashboard_currentStreak: 'Current streak',
      dashboard_recentActivities: 'Recent activities',
      dashboard_totalActivities: 'Total activities',
      dashboard_leaderboardPosition: 'Leaderboard position',
      dashboard_notRanked: 'Not ranked',
      dashboard_longestStreak: 'Longest streak',
      dashboard_totalDuration: 'Total duration',
      dashboard_widget_awaitingRsvp: 'Awaiting RSVP widget',
      dashboard_widget_outstandingPayments: 'Outstanding payments widget',
      dashboard_widget_stats: 'Stats',
      dashboard_widget_upcomingEvents: 'Upcoming events',
      dashboard_widget_activity: 'Activity',
      dashboard_widget_teamManagement: 'Team management',
      team_members: 'Members',
      team_rosters: 'Rosters',
      team_roles: 'Roles',
      team_groups: 'Groups',
      team_activityTypes: 'Activity types',
      team_trainingTypes: 'Training types',
      team_ageThresholds: 'Age thresholds',
      team_settings: 'Settings',
      event_allDayLabel: 'All day',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: React.PropsWithChildren<{ to?: string; params?: Record<string, string> }>) => {
    const href = to
      ? to.replace(/\$(\w+)/g, (_: string, key: string) => params?.[key] ?? key)
      : '#';
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock('~/components/atoms/EventLocation.js', () => ({
  EventLocation: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock('~/lib/datetime', async () => {
  const actual = await vi.importActual<typeof import('~/lib/datetime')>('~/lib/datetime');
  return {
    ...actual,
    formatLocalTime: () => '10:00',
  };
});

const { TeamDetailPage } = await import('~/components/pages/TeamDetailPage.js');

const TEAM_ID = 'team-1';

function makeDashboard() {
  return {
    upcomingEvents: [],
    awaitingRsvp: [],
    activitySummary: {
      currentStreak: 3,
      longestStreak: 10,
      recentActivityCount: 5,
      totalActivities: 42,
      totalDurationMinutes: 300,
      leaderboardRank: Option.some(2),
      leaderboardTotal: 20,
    },
    myMemberId: 'member-1' as import('@sideline/domain').TeamMember.TeamMemberId,
    todayLocalDate: Option.none<string>(),
  };
}

function makeAllDayEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-allday' as any,
    title: 'Tournament',
    eventType: 'match' as any,
    startAt: DateTime.fromDateUnsafe(new Date('2026-07-15T00:00:00Z')),
    endAt: Option.none(),
    location: Option.none(),
    locationUrl: Option.none(),
    myRsvp: Option.none(),
    startDate: Option.some('2026-07-15'),
    allDay: true,
    ...overrides,
  };
}

// Guard: prove the pin actually took effect, otherwise every assertion below would
// pass vacuously (plan §7.8's own warning about test 2/3).
describe('TeamDetailPage — all-day dashboard cards under Pacific/Auckland (PR 5, plan §7.8 item 3)', () => {
  it('the runtime timezone really is Pacific/Auckland for this file', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Auckland');
  });

  it('date badge still reads 15 / Jul, not 16 / Jul (a local read would shift it forward)', () => {
    const dashboard = {
      ...makeDashboard(),
      upcomingEvents: [makeAllDayEvent()],
      todayLocalDate: Option.some('2026-07-14'),
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={dashboard as any} />);

    expect(screen.getByText('15')).not.toBeNull();
    expect(screen.getByText('Jul')).not.toBeNull();
    expect(screen.queryByText('16')).toBeNull();
  });

  it('relative label is still "Today" when startDate equals todayLocalDate', () => {
    const dashboard = {
      ...makeDashboard(),
      upcomingEvents: [makeAllDayEvent({ startDate: Option.some('2026-07-14') })],
      todayLocalDate: Option.some('2026-07-14'),
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={dashboard as any} />);

    expect(screen.getByText(/Today/)).not.toBeNull();
  });
});
