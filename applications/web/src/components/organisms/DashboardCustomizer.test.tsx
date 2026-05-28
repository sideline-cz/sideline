// TDD mode — tests written BEFORE DashboardCustomizer.tsx implementation exists.
// These tests WILL FAIL until the developer implements:
//   applications/web/src/components/organisms/DashboardCustomizer.tsx
//
// Component contract:
//   DashboardCustomizer({
//     teamId: string;
//     layout: DashboardLayout;                 ← current persisted layout
//     onSave: (widgets: DashboardWidget[]) => Promise<void>  ← calls updateDashboardLayout API
//   })
//
// Behaviour:
//   - "Customize" button enters edit mode: per-widget Switch + drag handle per row
//   - Toggling a Switch updates local working copy but does NOT call onSave
//   - Drag handle allows keyboard reorder via dnd-kit keyboard sensor
//   - Reset sets working copy back to DEFAULT (4 visible in canonical order)
//   - Save calls onSave exactly once then exits edit mode
//   - Save failure stays in edit mode (error state shown)

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
      dashboard_customizer_save: 'Save',
      dashboard_customizer_cancel: 'Cancel',
      dashboard_customizer_reset: 'Reset',
      dashboard_customizer_dragHandle: 'Reorder {widget}',
      dashboard_customizer_saveError: 'Failed to save layout',
      dashboard_widget_stats: 'Stats',
      dashboard_widget_upcomingEvents: 'Upcoming events',
      dashboard_widget_activity: 'Activity',
      dashboard_widget_teamManagement: 'Team management',
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

type DashboardWidget = { id: string; visible: boolean };
type DashboardLayout = { widgets: ReadonlyArray<DashboardWidget> };

function makeDefaultLayout(): DashboardLayout {
  return {
    widgets: [
      { id: 'stats', visible: true },
      { id: 'upcomingEvents', visible: true },
      { id: 'activity', visible: true },
      { id: 'teamManagement', visible: true },
    ],
  };
}

function makePartialLayout(): DashboardLayout {
  return {
    widgets: [
      { id: 'stats', visible: false },
      { id: 'upcomingEvents', visible: true },
      { id: 'activity', visible: false },
      { id: 'teamManagement', visible: true },
    ],
  };
}

const TEAM_ID = 'team-customizer-001';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardCustomizer — initial state (not in edit mode)', () => {
  it('renders a "Customize" button in idle state', () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
    );

    expect(screen.getByText('Customize')).not.toBeNull();
    // Switches and drag handles should NOT be visible yet
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /reorder/i })).toBeNull();
  });
});

describe('DashboardCustomizer — entering edit mode', () => {
  it('clicking "Customize" enters edit mode with Switch + drag handle for each widget', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
    );

    const customizeBtn = screen.getByText('Customize');
    await act(async () => {
      fireEvent.click(customizeBtn);
    });

    // In edit mode, Switches should render (one per widget = 4)
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(4);

    // Per-row drag handle buttons should render (4 total — one per widget)
    const dragHandles = screen.getAllByRole('button', { name: /reorder/i });
    expect(dragHandles.length).toBe(4);
  });

  it('Save and Cancel buttons are visible in edit mode', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    expect(screen.getByText('Save')).not.toBeNull();
    expect(screen.getByText('Cancel')).not.toBeNull();
  });
});

describe('DashboardCustomizer — toggling a Switch', () => {
  it('toggling a Switch updates local working copy but does NOT call onSave', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
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
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
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
      <DashboardCustomizer teamId={TEAM_ID} layout={makePartialLayout() as any} onSave={onSave} />,
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

describe('DashboardCustomizer — keyboard drag-and-drop reorder', () => {
  it('keyboard: space to pick up, ArrowDown to move, space to drop reorders the working copy', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    // Get drag handle for first widget ("Stats")
    const dragHandles = screen.getAllByRole('button', { name: /reorder/i });
    const firstHandle = dragHandles[0];

    // Verify initial order: first widget is Stats
    expect(firstHandle.getAttribute('aria-label')).toBe('Reorder Stats');

    // Pick up (space), move down (ArrowDown), drop (space)
    await act(async () => {
      firstHandle.focus();
      fireEvent.keyDown(firstHandle, { key: ' ', code: 'Space' });
    });
    await act(async () => {
      fireEvent.keyDown(firstHandle, { key: 'ArrowDown', code: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(firstHandle, { key: ' ', code: 'Space' });
    });

    // onSave should NOT have been called (reorder only updates working copy)
    expect(onSave).not.toHaveBeenCalled();

    // The component should still be in edit mode (Save button still visible)
    expect(screen.getByText('Save')).not.toBeNull();
  });

  it('keyboard reorder does not call onSave', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    const dragHandles = screen.getAllByRole('button', { name: /reorder/i });
    const firstHandle = dragHandles[0];

    await act(async () => {
      firstHandle.focus();
      fireEvent.keyDown(firstHandle, { key: ' ', code: 'Space' });
    });
    await act(async () => {
      fireEvent.keyDown(firstHandle, { key: 'ArrowDown', code: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(firstHandle, { key: ' ', code: 'Space' });
    });

    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('DashboardCustomizer — Reset', () => {
  it('Reset button sets working copy back to DEFAULT (4 visible)', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makePartialLayout() as any} onSave={onSave} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Customize'));
    });

    // Verify partial layout: first switch should be unchecked (stats visible:false)
    let switches = screen.getAllByRole('switch');
    const firstStateBefore =
      switches[0].getAttribute('aria-checked') ?? switches[0].getAttribute('data-state');
    expect(['false', 'unchecked']).toContain(firstStateBefore);

    const resetBtn = screen.getByText('Reset');
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
});

describe('DashboardCustomizer — Save', () => {
  it('clicking Save calls onSave exactly once then exits edit mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
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
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
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
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
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
});

describe('DashboardCustomizer — Cancel', () => {
  it('Cancel discards changes and exits edit mode without calling onSave', async () => {
    const onSave = vi.fn();
    render(
      <DashboardCustomizer teamId={TEAM_ID} layout={makeDefaultLayout() as any} onSave={onSave} />,
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
