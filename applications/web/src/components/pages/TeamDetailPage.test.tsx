// Tests for TeamDetailPage with configurable dashboard layout.
//
// New TeamDetailPage contract:
//   TeamDetailPage({
//     teamId: string;
//     dashboard: DashboardApi.DashboardResponse | undefined;
//     myStatus?: ReadonlyArray<MyFinanceStatus>;
//     layout?: DashboardLayoutApi.DashboardLayout;   ← NEW prop
//   })
//
// Behaviour:
//   - Renders configurable widgets in layout order when visible:true
//   - A widget with visible:false is NOT rendered
//   - Pinned banners (AwaitingRsvp, OutstandingPayments) render regardless of layout
//   - All configurable hidden → empty-state element present inside configurable region
//   - layout undefined → falls back to DEFAULT (all 4 visible)

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      dashboard_allWidgetsHidden: 'All widgets hidden',
      dashboard_noWidgets: 'No widgets visible',
      dashboard_customize: 'Customize',
      dashboard_customizer_panelTitle: 'Widgets',
      dashboard_customizer_save: 'Save',
      dashboard_customizer_cancel: 'Cancel',
      dashboard_customizer_reset: 'Reset layout',
      dashboard_customizer_saveError: 'Failed to save layout',
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

type DashboardWidget = {
  id: string;
  visible: boolean;
  height: number;
  colSpan: number;
  x: number;
  y: number;
};
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
  it('renders 6 widgets in layout.widgets order when all are visible', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'teamManagement', visible: true, height: 260, colSpan: 1, x: 9, y: 5 },
        { id: 'activity', visible: true, height: 200, colSpan: 1, x: 9, y: 4 },
        { id: 'upcomingEvents', visible: true, height: 280, colSpan: 2, x: 1, y: 4 },
        { id: 'stats', visible: true, height: 140, colSpan: 3, x: 1, y: 3 },
        { id: 'awaitingRsvp', visible: true, height: 80, colSpan: 3, x: 1, y: 1 },
        { id: 'outstandingPayments', visible: true, height: 80, colSpan: 3, x: 1, y: 2 },
      ],
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} layout={layout as any} />);

    // All 6 should be present in DOM
    expect(screen.getByText('Team management')).not.toBeNull();
    expect(screen.getByText('Activity summary')).not.toBeNull();
    expect(screen.getByText('Upcoming events')).not.toBeNull();
    expect(screen.getByText('Current streak')).not.toBeNull();
  });

  it('a widget with visible:false is NOT rendered', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'awaitingRsvp', visible: true, height: 80, colSpan: 3, x: 1, y: 1 },
        { id: 'outstandingPayments', visible: true, height: 80, colSpan: 3, x: 1, y: 2 },
        { id: 'stats', visible: false, height: 140, colSpan: 3, x: 1, y: 3 },
        { id: 'upcomingEvents', visible: true, height: 280, colSpan: 2, x: 1, y: 4 },
        { id: 'activity', visible: true, height: 200, colSpan: 1, x: 9, y: 4 },
        { id: 'teamManagement', visible: true, height: 260, colSpan: 1, x: 9, y: 5 },
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

  it('AwaitingRsvp banner renders when its widget is visible in the layout', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'awaitingRsvp', visible: true, height: 80, colSpan: 3, x: 1, y: 1 },
        { id: 'outstandingPayments', visible: false, height: 80, colSpan: 3, x: 1, y: 2 },
        { id: 'stats', visible: false, height: 140, colSpan: 3, x: 1, y: 3 },
        { id: 'upcomingEvents', visible: false, height: 280, colSpan: 2, x: 1, y: 4 },
        { id: 'activity', visible: false, height: 200, colSpan: 1, x: 9, y: 4 },
        { id: 'teamManagement', visible: false, height: 260, colSpan: 1, x: 9, y: 5 },
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

    // AwaitingRsvp banner must be present (widget is visible and has data)
    expect(screen.getByText('Awaiting RSVP')).not.toBeNull();
  });

  it('OutstandingPayments banner renders when its widget is visible in the layout', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'awaitingRsvp', visible: false, height: 80, colSpan: 3, x: 1, y: 1 },
        { id: 'outstandingPayments', visible: true, height: 80, colSpan: 3, x: 1, y: 2 },
        { id: 'stats', visible: false, height: 140, colSpan: 3, x: 1, y: 3 },
        { id: 'upcomingEvents', visible: false, height: 280, colSpan: 2, x: 1, y: 4 },
        { id: 'activity', visible: false, height: 200, colSpan: 1, x: 9, y: 4 },
        { id: 'teamManagement', visible: false, height: 260, colSpan: 1, x: 9, y: 5 },
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

  it('all configurable widgets hidden → empty-state element inside configurable region', () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: 'awaitingRsvp', visible: false, height: 80, colSpan: 3, x: 1, y: 1 },
        { id: 'outstandingPayments', visible: false, height: 80, colSpan: 3, x: 1, y: 2 },
        { id: 'stats', visible: false, height: 140, colSpan: 3, x: 1, y: 3 },
        { id: 'upcomingEvents', visible: false, height: 280, colSpan: 2, x: 1, y: 4 },
        { id: 'activity', visible: false, height: 200, colSpan: 1, x: 9, y: 4 },
        { id: 'teamManagement', visible: false, height: 260, colSpan: 1, x: 9, y: 5 },
      ],
    };
    render(<TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} layout={layout as any} />);

    // An empty-state element should exist inside the configurable region
    const emptyState =
      document.querySelector('[data-testid="dashboard-empty-state"]') ??
      screen.queryByText('All widgets hidden');
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

// ---------------------------------------------------------------------------
// NEW: Customize button in page header
// ---------------------------------------------------------------------------

describe('TeamDetailPage — Customize button in page header', () => {
  it('Customize button renders in page header when userId and onSaveLayout are provided', () => {
    const onSaveLayout = vi.fn().mockResolvedValue(undefined);
    render(
      <TeamDetailPage
        teamId={TEAM_ID}
        userId='user-1'
        dashboard={makeDashboard()}
        onSaveLayout={onSaveLayout}
      />,
    );

    expect(screen.getByText('Customize')).not.toBeNull();
    // The button should be alongside the Dashboard title (in the same header row)
    expect(screen.getByText('Dashboard')).not.toBeNull();
  });

  it('Customize button does NOT render when userId is undefined', () => {
    const onSaveLayout = vi.fn().mockResolvedValue(undefined);
    render(
      <TeamDetailPage teamId={TEAM_ID} dashboard={makeDashboard()} onSaveLayout={onSaveLayout} />,
    );

    expect(screen.queryByText('Customize')).toBeNull();
  });

  it('Customize button does NOT render when onSaveLayout is undefined', () => {
    render(<TeamDetailPage teamId={TEAM_ID} userId='user-1' dashboard={makeDashboard()} />);

    expect(screen.queryByText('Customize')).toBeNull();
  });

  it('clicking Customize button in header transitions customizer to edit mode (aside panel appears)', async () => {
    const onSaveLayout = vi.fn().mockResolvedValue(undefined);
    render(
      <TeamDetailPage
        teamId={TEAM_ID}
        userId='user-1'
        dashboard={makeDashboard()}
        onSaveLayout={onSaveLayout}
      />,
    );

    // Aside panel should NOT be visible yet
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('Widgets')).toBeNull();

    const customizeBtn = screen.getByText('Customize');
    await act(async () => {
      fireEvent.click(customizeBtn);
    });

    // Aside panel should now be visible with widget switches (wait for effect to flush)
    await waitFor(() => {
      expect(screen.getByText('Widgets')).not.toBeNull();
    });
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(6);
  });
});
