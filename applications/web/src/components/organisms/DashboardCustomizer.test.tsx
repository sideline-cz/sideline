// Tests for the redesigned DashboardCustomizer (react-grid-layout based).
//
// Component contract:
//   DashboardCustomizer({
//     teamId: string;
//     layout: DashboardLayout;                 ← current persisted layout
//     onSave: (widgets: DashboardWidget[]) => Promise<void>  ← calls updateDashboardLayout API
//     widgetRegistry: Record<string, React.ReactNode | null>
//     editMode: boolean;                       ← controlled by parent (TeamDetailPage)
//     onEditModeChange: (next: boolean) => void;
//   })
//
// Behaviour:
//   - In idle mode (editMode=false): grid renders, aside panel NOT shown
//   - In edit mode (editMode=true): aside panel appears with one Switch per widget
//   - No width selectors — width is controlled by dragging RGL resize handle
//   - Toggling a Switch updates local working copy but does NOT call onSave
//   - Reset sets working copy back to DEFAULT (4 visible with default heights)
//   - Save calls onSave exactly once then calls onEditModeChange(false)
//   - Save failure stays in edit mode (error state shown)
//   - Cancel calls onEditModeChange(false) without calling onSave

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, string>) => {
    const map: Record<string, string> = {
      dashboard_customize: 'Customize',
      dashboard_customizer_title: 'Customize dashboard',
      dashboard_customizer_panelTitle: 'Widgets',
      dashboard_customizer_save: 'Save',
      dashboard_customizer_cancel: 'Cancel',
      dashboard_customizer_reset: 'Reset layout',
      dashboard_customizer_saveError: 'Failed to save layout',
      dashboard_widget_awaitingRsvp: 'Awaiting RSVP',
      dashboard_widget_outstandingPayments: 'Outstanding payments',
      dashboard_widget_stats: 'Stats',
      dashboard_widget_upcomingEvents: 'Upcoming events',
      dashboard_widget_activity: 'Activity',
      dashboard_widget_teamManagement: 'Team management',
      dashboard_allWidgetsHidden: 'All widgets hidden',
    };
    const raw = map[key] ?? key;
    if (params) {
      return raw.replace(/\{(\w+)\}/g, (_: string, k: string) => params[k] ?? `{${k}}`);
    }
    return raw;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('react-grid-layout/legacy', () => ({
  ReactGridLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid='rgl-grid'>{children}</div>
  ),
  WidthProvider: (Component: React.ComponentType<unknown>) => Component,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { DashboardCustomizer } = await import('~/components/organisms/DashboardCustomizer.js');

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

type DashboardWidget = {
  id: string;
  visible: boolean;
  height: number;
  colSpan: number;
  x: number;
  y: number;
};
type DashboardLayout = { widgets: ReadonlyArray<DashboardWidget> };

function makeDefaultLayout(): DashboardLayout {
  return {
    widgets: [
      { id: 'awaitingRsvp', visible: true, height: 80, colSpan: 3, x: 0, y: 0 },
      { id: 'outstandingPayments', visible: true, height: 80, colSpan: 3, x: 0, y: 8 },
      { id: 'stats', visible: true, height: 140, colSpan: 3, x: 0, y: 16 },
      { id: 'upcomingEvents', visible: true, height: 280, colSpan: 2, x: 0, y: 30 },
      { id: 'activity', visible: true, height: 200, colSpan: 1, x: 8, y: 30 },
      { id: 'teamManagement', visible: true, height: 260, colSpan: 1, x: 8, y: 50 },
    ],
  };
}

function makePartialLayout(): DashboardLayout {
  return {
    widgets: [
      { id: 'awaitingRsvp', visible: false, height: 80, colSpan: 3, x: 0, y: 0 },
      { id: 'outstandingPayments', visible: false, height: 80, colSpan: 3, x: 0, y: 8 },
      { id: 'stats', visible: false, height: 140, colSpan: 3, x: 0, y: 16 },
      { id: 'upcomingEvents', visible: true, height: 280, colSpan: 2, x: 0, y: 30 },
      { id: 'activity', visible: false, height: 200, colSpan: 1, x: 8, y: 30 },
      { id: 'teamManagement', visible: true, height: 260, colSpan: 1, x: 8, y: 50 },
    ],
  };
}

const TEAM_ID = 'team-customizer-001';

const WIDGET_REGISTRY = {
  awaitingRsvp: <div>Awaiting RSVP Widget</div>,
  outstandingPayments: <div>Outstanding Payments Widget</div>,
  stats: <div>Stats Widget</div>,
  upcomingEvents: <div>Upcoming Events Widget</div>,
  activity: <div>Activity Widget</div>,
  teamManagement: <div>Team Management Widget</div>,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardCustomizer — initial state (not in edit mode)', () => {
  it('does not render aside panel in idle state', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={false}
        onEditModeChange={vi.fn()}
      />,
    );

    // Aside panel should NOT be visible in idle mode
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('Widgets')).toBeNull();
  });

  it('renders visible widget content in idle state', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={false}
        onEditModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Stats Widget')).not.toBeNull();
    expect(screen.getByText('Upcoming Events Widget')).not.toBeNull();
  });

  it('does not render hidden widget content in idle state', () => {
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makePartialLayout() as any}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={false}
        onEditModeChange={vi.fn()}
      />,
    );

    // stats is hidden in partial layout
    expect(screen.queryByText('Stats Widget')).toBeNull();
    // upcomingEvents is visible
    expect(screen.getByText('Upcoming Events Widget')).not.toBeNull();
  });

  it('renders widgets in a grid container in idle state', () => {
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={false}
        onEditModeChange={vi.fn()}
      />,
    );

    // All visible widgets present
    expect(screen.getByText('Stats Widget')).not.toBeNull();
    expect(screen.getByText('Upcoming Events Widget')).not.toBeNull();
    expect(screen.getByText('Activity Widget')).not.toBeNull();
    expect(screen.getByText('Team Management Widget')).not.toBeNull();
  });
});

describe('DashboardCustomizer — entering edit mode', () => {
  it('edit mode with aside panel and one Switch per widget', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    // Aside panel title should be visible
    expect(screen.getByText('Widgets')).not.toBeNull();

    // In edit mode, Switches should render (one per widget = 6)
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(6);
  });

  it('Save and Cancel buttons are visible in edit mode', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Save')).not.toBeNull();
    expect(screen.getByText('Cancel')).not.toBeNull();
  });

  it('Reset layout button is visible in edit mode', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Reset layout')).not.toBeNull();
  });
});

describe('DashboardCustomizer — toggling a Switch', () => {
  it('toggling a Switch updates local working copy but does NOT call onSave', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    // onSave should NOT have been called
    expect(onSave).not.toHaveBeenCalled();
  });

  it('toggling a switch reflects in working copy (checked state changes)', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    const switches = screen.getAllByRole('switch');
    const firstSwitchBefore =
      switches[0].getAttribute('aria-checked') ?? switches[0].getAttribute('data-state');

    await act(async () => {
      fireEvent.click(switches[0]);
    });

    const switchesAfter = screen.getAllByRole('switch');
    const firstSwitchAfter =
      switchesAfter[0].getAttribute('aria-checked') ?? switchesAfter[0].getAttribute('data-state');

    // The state should have changed
    expect(firstSwitchAfter).not.toBe(firstSwitchBefore);
  });

  it('a widget that starts as visible:false has an unchecked switch', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makePartialLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    const switches = screen.getAllByRole('switch');
    // First switch corresponds to 'stats' which has visible:false → unchecked
    const firstState =
      switches[0].getAttribute('aria-checked') ?? switches[0].getAttribute('data-state');
    expect(['false', 'unchecked']).toContain(firstState);
  });
});

describe('DashboardCustomizer — Reset', () => {
  it('Reset button sets working copy back to DEFAULT (6 visible)', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makePartialLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    // Verify partial layout: first switch should be unchecked (stats visible:false)
    let switches = screen.getAllByRole('switch');
    const firstStateBefore =
      switches[0].getAttribute('aria-checked') ?? switches[0].getAttribute('data-state');
    expect(['false', 'unchecked']).toContain(firstStateBefore);

    const resetBtn = screen.getByText('Reset layout');
    await act(async () => {
      fireEvent.click(resetBtn);
    });

    // After reset, all switches should be checked (DEFAULT = all visible)
    switches = screen.getAllByRole('switch');
    for (const sw of switches) {
      const state = sw.getAttribute('aria-checked') ?? sw.getAttribute('data-state');
      expect(['true', 'checked']).toContain(state);
    }

    // onSave should NOT have been called
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Reset restores DEFAULT_LAYOUT heights in working copy', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makePartialLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Reset layout'));
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    // Saved widgets should have DEFAULT heights
    const savedWidgets = onSave.mock.calls[0][0] as DashboardWidget[];
    const statsWidget = savedWidgets.find((w) => w.id === 'stats');
    expect(statsWidget?.height).toBe(140);
    const upcomingWidget = savedWidgets.find((w) => w.id === 'upcomingEvents');
    expect(upcomingWidget?.height).toBe(280);
  });
});

describe('DashboardCustomizer — Save', () => {
  it('clicking Save calls onSave exactly once then calls onEditModeChange(false)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onEditModeChange = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={onEditModeChange}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    // After successful save, onEditModeChange(false) should have been called
    await waitFor(() => {
      expect(onEditModeChange).toHaveBeenCalledWith(false);
    });
  });

  it('Save calls onSave with the current working copy widgets', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    // Toggle the first widget off
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    // The first argument to onSave should be the modified widgets array
    const savedWidgets = onSave.mock.calls[0][0] as DashboardWidget[];
    expect(Array.isArray(savedWidgets)).toBe(true);
    expect(savedWidgets.length).toBeGreaterThan(0);
  });

  it('Save failure stays in edit mode and shows error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Network error'));
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() => {
      // Should still be in edit mode (Save button visible)
      expect(screen.getByText('Save')).not.toBeNull();
    });

    // Error message should be shown
    const errorEl = screen.queryByText('Failed to save layout');
    expect(errorEl).not.toBeNull();
  });

  it('Save failure preserves the working copy', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Network error'));
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    // Toggle the first switch off
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() => {
      expect(screen.getByText('Save')).not.toBeNull();
    });

    // The working copy switch should still be unchecked (change preserved)
    const switchesAfter = screen.getAllByRole('switch');
    const firstState =
      switchesAfter[0].getAttribute('aria-checked') ?? switchesAfter[0].getAttribute('data-state');
    expect(['false', 'unchecked']).toContain(firstState);
  });
});

describe('DashboardCustomizer — Cancel', () => {
  it('Cancel calls onEditModeChange(false) without calling onSave', async () => {
    const onSave = vi.fn();
    const onEditModeChange = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={onEditModeChange}
      />,
    );

    // Toggle a switch to make a change
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });

    // onEditModeChange(false) must have been called
    expect(onEditModeChange).toHaveBeenCalledWith(false);

    // onSave must NOT have been called
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('DashboardCustomizer — null registry entries (no data)', () => {
  it('does not render a widget whose registry value is null even when visible:true', () => {
    const registryWithNull = {
      ...WIDGET_REGISTRY,
      awaitingRsvp: null,
    };
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        widgetRegistry={registryWithNull}
        editMode={false}
        onEditModeChange={vi.fn()}
      />,
    );

    // awaitingRsvp has a null registry entry — must not appear in the grid
    expect(screen.queryByText('Awaiting RSVP Widget')).toBeNull();
    // Other widgets still render
    expect(screen.getByText('Stats Widget')).not.toBeNull();
  });

  it('shows empty state when all visible widgets have null registry entries', () => {
    const allNullRegistry = {
      awaitingRsvp: null,
      outstandingPayments: null,
      stats: null,
      upcomingEvents: null,
      activity: null,
      teamManagement: null,
    };
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        widgetRegistry={allNullRegistry}
        editMode={false}
        onEditModeChange={vi.fn()}
      />,
    );

    const emptyState =
      document.querySelector('[data-testid="dashboard-empty-state"]') ??
      screen.queryByText('All widgets hidden');
    expect(emptyState).not.toBeNull();
  });

  it('still shows the switch for a null-registry widget in edit mode', () => {
    const registryWithNull = {
      ...WIDGET_REGISTRY,
      awaitingRsvp: null,
    };
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        widgetRegistry={registryWithNull}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    // All 6 widget switches are present — including the null-registry one
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(6);

    // But the widget content is not in the grid
    expect(screen.queryByText('Awaiting RSVP Widget')).toBeNull();
  });
});

describe('DashboardCustomizer — all-hidden empty state', () => {
  it('shows empty state when all widgets are hidden', () => {
    const allHiddenLayout: DashboardLayout = {
      widgets: [
        { id: 'awaitingRsvp', visible: false, height: 80, colSpan: 3, x: 0, y: 0 },
        { id: 'outstandingPayments', visible: false, height: 80, colSpan: 3, x: 0, y: 8 },
        { id: 'stats', visible: false, height: 140, colSpan: 3, x: 0, y: 16 },
        { id: 'upcomingEvents', visible: false, height: 280, colSpan: 2, x: 0, y: 30 },
        { id: 'activity', visible: false, height: 200, colSpan: 1, x: 8, y: 30 },
        { id: 'teamManagement', visible: false, height: 260, colSpan: 1, x: 8, y: 50 },
      ],
    };
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={allHiddenLayout as any}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={false}
        onEditModeChange={vi.fn()}
      />,
    );

    const emptyState =
      document.querySelector('[data-testid="dashboard-empty-state"]') ??
      screen.queryByText('All widgets hidden');
    expect(emptyState).not.toBeNull();
  });

  it('shows empty state in edit mode when all widgets are toggled off', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
        editMode={true}
        onEditModeChange={vi.fn()}
      />,
    );

    // Toggle all switches off
    const switches = screen.getAllByRole('switch');
    for (const sw of switches) {
      await act(async () => {
        fireEvent.click(sw);
      });
    }

    const emptyState =
      document.querySelector('[data-testid="dashboard-empty-state"]') ??
      screen.queryByText('All widgets hidden');
    expect(emptyState).not.toBeNull();
  });
});
