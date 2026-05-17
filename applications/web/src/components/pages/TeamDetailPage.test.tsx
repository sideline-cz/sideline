// TDD mode — tests written BEFORE TeamDetailPage.tsx is updated to accept myStatus.
// These tests WILL FAIL until:
//   - TeamDetailPage.tsx is updated to accept myStatus prop and render OutstandingPaymentsBanner
//   - OutstandingPaymentsBanner.tsx is implemented
//
// Component contract (updated):
//   TeamDetailPage({
//     teamId: string;
//     dashboard: DashboardApi.DashboardResponse | undefined;
//     myStatus?: ReadonlyArray<MyFinanceStatus>;   ← NEW prop
//   })
//
// New behaviour:
//   - Renders <OutstandingPaymentsBanner> after <AwaitingRsvpBanner>
//   - Banner absent when myStatus is empty or undefined
//   - Existing dashboard widgets still render (smoke test)

import { render, screen } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      dashboard_title: 'Dashboard',
      dashboard_today: 'Today',
      dashboard_tomorrow: 'Tomorrow',
      dashboard_awaitingRsvp: 'Awaiting RSVP',
      dashboard_noResponse: 'No response',
      dashboard_rsvpYes: 'Yes',
      dashboard_rsvpNo: 'No',
      dashboard_rsvpMaybe: 'Maybe',
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
      team_members: 'Members',
      team_rosters: 'Rosters',
      team_roles: 'Roles',
      team_groups: 'Groups',
      team_activityTypes: 'Activity types',
      team_trainingTypes: 'Training types',
      team_ageThresholds: 'Age thresholds',
      team_settings: 'Settings',
      // Banner translations
      my_payments_banner_titleAmber: 'You have outstanding payments',
      my_payments_banner_titleRed: 'You have overdue payments',
      my_payments_banner_cta_viewAll: 'View all',
      my_payments_banner_more: '+{n} more',
      finance_status_pending: 'Pending',
      finance_status_partial: 'Partial',
      finance_status_overdue: 'Overdue',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

// Stub TanStack router Link
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

// Stub EventLocation
vi.mock('~/components/atoms/EventLocation.js', () => ({
  EventLocation: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock('~/lib/datetime', () => ({
  formatLocalTime: () => '10:00',
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { TeamDetailPage } = await import('~/components/pages/TeamDetailPage.js');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type FeeAssignmentView = {
  assignmentId: string;
  feeId: string;
  teamMemberId: string;
  memberName: Option.Option<string>;
  feeName: string;
  currency: string;
  dueMinor: number;
  paidMinor: number;
  status: 'pending' | 'partial' | 'overdue' | 'paid' | 'waived';
  effectiveDueAt: Option.Option<DateTime.Utc>;
  waivedReason: Option.Option<string>;
};

type MyFinanceStatus = {
  currency: string;
  assignments: ReadonlyArray<FeeAssignmentView>;
  totalOutstandingMinor: number;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  };
}

function makePendingAssignment(id: string): FeeAssignmentView {
  return {
    assignmentId: id,
    feeId: `fee-${id}`,
    teamMemberId: 'member-1',
    memberName: Option.some('Alice'),
    feeName: `Fee ${id}`,
    currency: 'CZK',
    dueMinor: 5000,
    paidMinor: 0,
    status: 'pending',
    effectiveDueAt: Option.some(DateTime.fromDateUnsafe(new Date('2025-08-01T00:00:00Z'))),
    waivedReason: Option.none(),
  };
}

const TEAM_ID = 'team-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamDetailPage — banner integration', () => {
  it('banner absent when myStatus is empty', () => {
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} myStatus={[]} />);

    // The outstanding payments banner should NOT be present
    const banner =
      document.querySelector('[data-variant="amber"]') ??
      document.querySelector('[data-variant="red"]');
    expect(banner).toBeNull();
  });

  it('banner absent when myStatus is undefined (default)', () => {
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} />);

    const banner =
      document.querySelector('[data-variant="amber"]') ??
      document.querySelector('[data-variant="red"]');
    expect(banner).toBeNull();
  });

  it('banner present when outstanding exists (after AwaitingRsvpBanner)', () => {
    const myStatus: MyFinanceStatus[] = [
      {
        currency: 'CZK',
        assignments: [makePendingAssignment('fee-outstanding')],
        totalOutstandingMinor: 5000,
      },
    ];
    const dashboard = makeDashboard();

    render(<TeamDetailPage teamId={TEAM_ID} dashboard={dashboard} myStatus={myStatus} />);

    // Outstanding banner should be rendered
    const banner =
      document.querySelector('[data-variant="amber"]') ??
      document.querySelector('[data-variant="red"]');
    expect(banner).not.toBeNull();
  });

  it('existing dashboard widgets still render (smoke test)', () => {
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} myStatus={[]} />);

    // Activity summary section should render
    expect(screen.getByText('Activity summary')).not.toBeNull();
    // Team management section
    expect(screen.getByText('Team management')).not.toBeNull();
    // Stat cards
    expect(screen.getByText('Current streak')).not.toBeNull();
  });
});
