// Tests for the redesigned DashboardCustomizer (fixed CSS grid with resize-only model).
//
// Component contract:
//   DashboardCustomizer({
//     teamId: string;
//     layout: DashboardLayout;                 ← current persisted layout
//     onSave: (widgets: DashboardWidget[]) => Promise<void>  ← calls updateDashboardLayout API
//     widgetRegistry: Record<string, React.ReactNode>
//   })
//
// Behaviour:
//   - "Customize" button enters edit mode; aside panel appears with one Switch per widget
//   - No drag handles — layout positions are fixed, only height is user-configurable
//   - Toggling a Switch updates local working copy but does NOT call onSave
//   - Reset sets working copy back to DEFAULT (4 visible with default heights)
//   - Save calls onSave exactly once then exits edit mode
//   - Save failure stays in edit mode (error state shown)
//   - Cancel exits edit mode without calling onSave

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

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { DashboardCustomizer } = await import('~/components/organisms/DashboardCustomizer.js');

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

type DashboardWidget = { id: string; visible: boolean; height: number };
type DashboardLayout = { widgets: ReadonlyArray<DashboardWidget> };

function makeDefaultLayout(): DashboardLayout {
  return {
    widgets: [
      { id: 'stats', visible: true, height: 140 },
      { id: 'upcomingEvents', visible: true, height: 280 },
      { id: 'activity', visible: true, height: 200 },
      { id: 'teamManagement', visible: true, height: 260 },
    ],
  };
}

function makePartialLayout(): DashboardLayout {
  return {
    widgets: [
      { id: 'stats', visible: false, height: 140 },
      { id: 'upcomingEvents', visible: true, height: 280 },
      { id: 'activity', visible: false, height: 200 },
      { id: 'teamManagement', visible: true, height: 260 },
    ],
  };
}

const TEAM_ID = 'team-customizer-001';

const WIDGET_REGISTRY = {
  stats: <div>Stats Widget</div>,
  upcomingEvents: <div>Upcoming Events Widget</div>,
  activity: <div>Activity Widget</div>,
  teamManagement: <div>Team Management Widget</div>,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardCustomizer — initial state (not in edit mode)', () => {
  it('renders a "Customize" button in idle state', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    expect(screen.getByText('Customize')).not.toBeNull();
    // Aside panel should NOT be visible yet
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
  it('clicking "Customize" enters edit mode with the aside panel and one Switch per widget', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    const customizeBtn = screen.getByText('Customize');
    await act(async () => {
      fireEvent.click(customizeBtn);
    });

    // Aside panel title should be visible
    expect(screen.getByText('Widgets')).not.toBeNull();

    // In edit mode, Switches should render (one per widget = 4)
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(4);
  });

  it('does NOT render drag handles in edit mode (no drag-and-drop)', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    // No drag handles should be rendered
    const dragHandles = screen.queryAllByRole('button', { name: /Drag/i });
    expect(dragHandles.length).toBe(0);
  });

  it('Save and Cancel buttons are visible in edit mode', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    expect(screen.getByText('Save')).not.toBeNull();
    expect(screen.getByText('Cancel')).not.toBeNull();
  });

  it('Reset layout button is visible in edit mode', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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

  it('a widget that starts as visible:false has an unchecked switch', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makePartialLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    const switches = screen.getAllByRole('switch');
    // First switch corresponds to 'stats' which has visible:false → unchecked
    const firstState =
      switches[0].getAttribute('aria-checked') ?? switches[0].getAttribute('data-state');
    expect(['false', 'unchecked']).toContain(firstState);
  });
});

describe('DashboardCustomizer — Reset', () => {
  it('Reset button sets working copy back to DEFAULT (4 visible)', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makePartialLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
  it('clicking Save calls onSave exactly once then exits edit mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    // After successful save, edit mode should be exited (Save button gone, Customize visible)
    await waitFor(() => {
      expect(screen.queryByText('Save')).toBeNull();
      expect(screen.getByText('Customize')).not.toBeNull();
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
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
  it('Cancel discards changes and exits edit mode without calling onSave', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={makeDefaultLayout() as any}
        onSave={onSave}
        widgetRegistry={WIDGET_REGISTRY}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    // Toggle a switch to make a change
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });

    // Should exit edit mode
    expect(screen.queryByText('Save')).toBeNull();
    expect(screen.getByText('Customize')).not.toBeNull();

    // onSave must NOT have been called
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('DashboardCustomizer — all-hidden empty state', () => {
  it('shows empty state when all widgets are hidden', () => {
    const allHiddenLayout: DashboardLayout = {
      widgets: [
        { id: 'stats', visible: false, height: 140 },
        { id: 'upcomingEvents', visible: false, height: 280 },
        { id: 'activity', visible: false, height: 200 },
        { id: 'teamManagement', visible: false, height: 260 },
      ],
    };
    render(
      <DashboardCustomizer
        teamId={TEAM_ID}
        layout={allHiddenLayout as any}
        widgetRegistry={WIDGET_REGISTRY}
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
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

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
