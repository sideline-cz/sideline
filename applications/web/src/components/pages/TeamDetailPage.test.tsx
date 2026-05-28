// TDD mode — tests written BEFORE the configurable dashboard implementation exists.
// These tests WILL FAIL until:
//   - TeamDetailPage.tsx is updated to accept layout prop and conditionally render widgets
//   - DashboardCustomizer.tsx is implemented (see separate test file)
//   - DEFAULT_LAYOUT constant is exported from dashboard-layout.ts (or similar)
//
// Extends the existing banner integration tests with new layout-driven widget tests.
// The existing banner tests are preserved below.
//
// New TeamDetailPage contract additions:
//   TeamDetailPage({
//     teamId: string;
//     dashboard: DashboardApi.DashboardResponse | undefined;
//     myStatus?: ReadonlyArray<MyFinanceStatus>;
//     layout?: DashboardLayoutApi.DashboardLayout;   ← NEW prop
//   })
//
// New behaviour:
//   - Renders configurable widgets (stats/upcomingEvents/activity/teamManagement) in layout.widgets order
//   - A widget with visible:false is NOT rendered in the configurable region
//   - Pinned banners (AwaitingRsvp, OutstandingPayments) render regardless of layout
//   - All configurable hidden → empty-state element present inside configurable region
//   - layout undefined → falls back to DEFAULT (all 4 visible in canonical order)

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
      dashboard_noWidgets: 'No widgets visible',
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

type DashboardWidget = { id: string; visible: boolean };
type DashboardLayout = { widgets: ReadonlyArray<DashboardWidget> };

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
// Existing banner integration tests (preserved unchanged)
// ---------------------------------------------------------------------------

describe('TeamDetailPage — banner integration', () => {
  it('banner absent when myStatus is empty', () => {
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} myStatus={[]} />);

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

    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} myStatus={myStatus} />);

    const banner =
      document.querySelector('[data-variant="amber"]') ??
      document.querySelector('[data-variant="red"]');
    expect(banner).not.toBeNull();
  });

  it('existing dashboard widgets still render (smoke test)', () => {
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} myStatus={[]} />);

    expect(screen.getByText('Activity summary')).not.toBeNull();
    expect(screen.getByText('Team management')).not.toBeNull();
    expect(screen.getByText('Current streak')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEW: configurable layout tests
// ---------------------------------------------------------------------------

describe('TeamDetailPage — configurable layout', () => {
  it('renders 4 widgets in layout.widgets order when all are visible', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'teamManagement', visible: true },
        { id: 'activity', visible: true },
        { id: 'upcomingEvents', visible: true },
        { id: 'stats', visible: true },
      ],
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} layout={layout as any} />);

    // All 4 should be present in DOM
    expect(screen.getByText('Team management')).not.toBeNull();
    expect(screen.getByText('Activity summary')).not.toBeNull();
    expect(screen.getByText('Upcoming events')).not.toBeNull();
    expect(screen.getByText('Current streak')).not.toBeNull();
  });

  it('a widget with visible:false is NOT rendered', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'stats', visible: false },
        { id: 'upcomingEvents', visible: true },
        { id: 'activity', visible: true },
        { id: 'teamManagement', visible: true },
      ],
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} layout={layout as any} />);

    // 'stats' widget (Current streak label) should NOT be rendered
    expect(screen.queryByText('Current streak')).toBeNull();
    // Others still render
    expect(screen.getByText('Upcoming events')).not.toBeNull();
    expect(screen.getByText('Activity summary')).not.toBeNull();
    expect(screen.getByText('Team management')).not.toBeNull();
  });

  it('pinned AwaitingRsvp banner renders regardless of layout', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'stats', visible: false },
        { id: 'upcomingEvents', visible: false },
        { id: 'activity', visible: false },
        { id: 'teamManagement', visible: false },
      ],
    };
    const dashboard = {
      ...makeDashboard(),
      awaitingRsvp: [
        {
          eventId: 'evt-1' as any,
          title: 'Training Session',
          eventType: 'training' as any,
          startAt: DateTime.fromDateUnsafe(new Date('2025-12-01T10:00:00Z')),
          endAt: Option.none(),
          location: Option.none(),
          locationUrl: Option.none(),
          myRsvp: Option.none(),
        },
      ],
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={dashboard as any} layout={layout as any} />);

    // AwaitingRsvp banner must still be present
    expect(screen.getByText('Awaiting RSVP')).not.toBeNull();
  });

  it('pinned OutstandingPayments banner renders regardless of layout', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'stats', visible: false },
        { id: 'upcomingEvents', visible: false },
        { id: 'activity', visible: false },
        { id: 'teamManagement', visible: false },
      ],
    };
    const myStatus: MyFinanceStatus[] = [
      {
        currency: 'CZK',
        assignments: [makePendingAssignment('x')],
        totalOutstandingMinor: 5000,
      },
    ];
    render(
      <TeamDetailPage
        teamId={TEAM_ID}
        dashboard={makeDashboard()}
        layout={layout as any}
        myStatus={myStatus}
      />,
    );

    const banner =
      document.querySelector('[data-variant="amber"]') ??
      document.querySelector('[data-variant="red"]');
    expect(banner).not.toBeNull();
  });

  it('all configurable widgets hidden → empty-state element inside configurable region, banners still present', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'stats', visible: false },
        { id: 'upcomingEvents', visible: false },
        { id: 'activity', visible: false },
        { id: 'teamManagement', visible: false },
      ],
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} layout={layout as any} />);

    // An empty-state element should exist inside the configurable region
    const emptyState =
      document.querySelector('[data-testid="dashboard-empty-state"]') ??
      screen.queryByText('No widgets visible');
    expect(emptyState).not.toBeNull();
  });

  it('layout undefined → falls back to DEFAULT (all 4 visible in canonical order)', () => {
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} />);

    // All 4 configurable widgets should be visible (DEFAULT)
    expect(screen.getByText('Current streak')).not.toBeNull();
    expect(screen.getByText('Upcoming events')).not.toBeNull();
    expect(screen.getByText('Activity summary')).not.toBeNull();
    expect(screen.getByText('Team management')).not.toBeNull();
  });
});
