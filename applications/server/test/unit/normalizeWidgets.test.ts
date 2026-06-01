// Tests for normalizeWidgets in applications/server/src/api/dashboard-layout.ts
//
// normalizeWidgets:
//   - Deduplicates by id (keeps first occurrence)
//   - Drops unknown ids
//   - Appends missing canonical widgets with default heights from DEFAULT_LAYOUT
//   - Preserves visible:false on existing widgets

import { describe, expect, it } from '@effect/vitest';
import { DashboardLayoutApi } from '@sideline/domain';
import { normalizeWidgets } from '~/api/dashboard-layout.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const defaultEntry = (id: DashboardLayoutApi.DashboardWidgetId) =>
  DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === id)!;

const w = (
  id: DashboardLayoutApi.DashboardWidgetId,
  visible: boolean,
): DashboardLayoutApi.DashboardWidget => {
  const entry = defaultEntry(id);
  return new DashboardLayoutApi.DashboardWidget({
    id,
    visible,
    height: entry.height,
    colSpan: entry.colSpan,
    x: entry.x,
    y: entry.y,
  });
};

// ---------------------------------------------------------------------------
// normalizeWidgets
// ---------------------------------------------------------------------------

describe('normalizeWidgets — empty input', () => {
  it('empty [] → all 6 canonical widgets visible with DEFAULT_LAYOUT heights', () => {
    const result = normalizeWidgets([]);
    expect(result).toHaveLength(6);
    expect(result[0].id).toBe('awaitingRsvp');
    expect(result[1].id).toBe('outstandingPayments');
    expect(result[2].id).toBe('stats');
    expect(result[3].id).toBe('upcomingEvents');
    expect(result[4].id).toBe('activity');
    expect(result[5].id).toBe('teamManagement');
    for (const widget of result) {
      expect(widget.visible).toBe(true);
      expect(typeof widget.height).toBe('number');
    }
  });
});

describe('normalizeWidgets — full valid scrambled input', () => {
  it('full scrambled valid input → same widgets, preserves scrambled order, no appends', () => {
    const input = [
      w('teamManagement', true),
      w('activity', false),
      w('upcomingEvents', true),
      w('stats', false),
      w('awaitingRsvp', true),
      w('outstandingPayments', false),
    ];
    const result = normalizeWidgets(input);
    // All 6 present, no extras appended
    expect(result).toHaveLength(6);
    // Order is preserved from input
    expect(result[0].id).toBe('teamManagement');
    expect(result[1].id).toBe('activity');
    expect(result[2].id).toBe('upcomingEvents');
    expect(result[3].id).toBe('stats');
    expect(result[4].id).toBe('awaitingRsvp');
    expect(result[5].id).toBe('outstandingPayments');
    // Visibility preserved
    expect(result[0].visible).toBe(true);
    expect(result[1].visible).toBe(false);
    expect(result[3].visible).toBe(false);
    expect(result[5].visible).toBe(false);
  });
});

describe('normalizeWidgets — partial input', () => {
  it('[teamManagement hidden] → first, then other 5 appended visible below existing', () => {
    const input = [w('teamManagement', false)];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(6);
    // First: the given widget, hidden
    expect(result[0].id).toBe('teamManagement');
    expect(result[0].visible).toBe(false);
    // Appended missing: awaitingRsvp, outstandingPayments, stats, upcomingEvents, activity (from DEFAULT_LAYOUT order)
    const appendedIds = result.slice(1).map((r) => r.id);
    expect(appendedIds).toContain('awaitingRsvp');
    expect(appendedIds).toContain('outstandingPayments');
    expect(appendedIds).toContain('stats');
    expect(appendedIds).toContain('upcomingEvents');
    expect(appendedIds).toContain('activity');
    // Appended are visible
    for (const widget of result.slice(1)) {
      expect(widget.visible).toBe(true);
    }
  });

  it('[stats, activity] → stats first, activity second, 4 others appended visible', () => {
    const input = [w('stats', false), w('activity', false)];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(6);
    expect(result[0].id).toBe('stats');
    expect(result[0].visible).toBe(false);
    expect(result[1].id).toBe('activity');
    expect(result[1].visible).toBe(false);
    // Appended from DEFAULT_LAYOUT order
    const appendedIds = result.slice(2).map((r) => r.id);
    expect(appendedIds).toContain('awaitingRsvp');
    expect(appendedIds).toContain('outstandingPayments');
    expect(appendedIds).toContain('upcomingEvents');
    expect(appendedIds).toContain('teamManagement');
    for (const widget of result.slice(2)) {
      expect(widget.visible).toBe(true);
    }
  });

  it('appended missing widgets have height field', () => {
    const input = [w('stats', true)];
    const result = normalizeWidgets(input);
    for (const widget of result) {
      expect(typeof widget.height).toBe('number');
    }
  });
});

describe('normalizeWidgets — deduplicate', () => {
  it('stats appearing twice → only one stats, first-occurrence visibility kept', () => {
    const input = [w('stats', false), w('stats', true), w('activity', true)];
    const result = normalizeWidgets(input);
    const statsEntries = result.filter((r) => r.id === 'stats');
    expect(statsEntries).toHaveLength(1);
    // First occurrence has visible:false
    expect(statsEntries[0].visible).toBe(false);
  });

  it('all six present but stats duplicated → result length 6, not 7', () => {
    const input = [
      w('awaitingRsvp', true),
      w('outstandingPayments', true),
      w('stats', true),
      w('upcomingEvents', true),
      w('activity', true),
      w('teamManagement', true),
      w('stats', false),
    ];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(6);
  });
});

describe('normalizeWidgets — drop unknown ids', () => {
  it('input with an invalid id object → dropped, only valid widgets remain', () => {
    // Cast to bypass TypeScript; at runtime normalizeWidgets receives arbitrary data.
    const input = [
      {
        id: 'fakeUnknown',
        visible: true,
        height: 200,
        colSpan: 1,
        x: 0,
        y: 0,
      } as unknown as DashboardLayoutApi.DashboardWidget,
      w('stats', true),
    ];
    const result = normalizeWidgets(input);
    // 'fakeUnknown' is not a valid DashboardWidgetId → dropped
    const fakeEntries = result.filter((r) => r.id === ('fakeUnknown' as any));
    expect(fakeEntries).toHaveLength(0);
    // The valid ones (stats) plus the 5 missing appended
    expect(result).toHaveLength(6);
    expect(result.some((r) => r.id === 'stats')).toBe(true);
  });
});

describe('normalizeWidgets — preserves visible:false', () => {
  it('does not force-enable a widget that is explicitly hidden', () => {
    const input = [
      w('awaitingRsvp', false),
      w('outstandingPayments', false),
      w('stats', false),
      w('upcomingEvents', false),
      w('activity', false),
      w('teamManagement', false),
    ];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(6);
    for (const widget of result) {
      expect(widget.visible).toBe(false);
    }
  });
});

describe('normalizeWidgets — height field preserved', () => {
  it('preserves the input height for widgets that have one', () => {
    const customHeight = 350;
    const input = [
      new DashboardLayoutApi.DashboardWidget({
        id: 'stats',
        visible: true,
        height: customHeight,
        colSpan: 3,
        x: 1,
        y: 1,
      }),
    ];
    const result = normalizeWidgets(input);
    const stats = result.find((r) => r.id === 'stats');
    expect(stats).toBeDefined();
    expect(stats?.height).toBe(customHeight);
  });

  it('appended missing widgets use DEFAULT_LAYOUT height', () => {
    const input = [w('stats', true)];
    const result = normalizeWidgets(input);
    for (const widget of result) {
      const defaultH = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === widget.id)?.height;
      if (widget.id !== 'stats') {
        // Appended widgets should use default height
        expect(widget.height).toBe(defaultH);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeWidgets — colSpan field
// ---------------------------------------------------------------------------

describe('normalizeWidgets — colSpan field', () => {
  it('preserves a valid colSpan (1) from input', () => {
    const input = [w('activity', true)]; // activity has colSpan 1 in DEFAULT_LAYOUT
    const result = normalizeWidgets(input);
    const activity = result.find((r) => r.id === 'activity');
    expect(activity?.colSpan).toBe(1);
  });

  it('preserves a valid colSpan (2) from input', () => {
    const input = [w('upcomingEvents', true)]; // upcomingEvents has colSpan 2
    const result = normalizeWidgets(input);
    const upcoming = result.find((r) => r.id === 'upcomingEvents');
    expect(upcoming?.colSpan).toBe(2);
  });

  it('clamps colSpan 0 to 1', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'stats')!;
    // Use a plain object cast to bypass Schema validation (simulates a drifted stored value)
    const input = [
      {
        id: 'stats',
        visible: true,
        height: entry.height,
        colSpan: 0,
        x: entry.x,
        y: entry.y,
      } as unknown as DashboardLayoutApi.DashboardWidget,
    ];
    const result = normalizeWidgets(input);
    expect(result.find((r) => r.id === 'stats')?.colSpan).toBe(1);
  });

  it('clamps colSpan 5 to 3', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'stats')!;
    // Use a plain object cast to bypass Schema validation (simulates a drifted stored value)
    const input = [
      {
        id: 'stats',
        visible: true,
        height: entry.height,
        colSpan: 5,
        x: entry.x,
        y: entry.y,
      } as unknown as DashboardLayoutApi.DashboardWidget,
    ];
    const result = normalizeWidgets(input);
    expect(result.find((r) => r.id === 'stats')?.colSpan).toBe(3);
  });

  it('appended missing widgets use DEFAULT_LAYOUT colSpan', () => {
    const input = [w('stats', true)];
    const result = normalizeWidgets(input);
    for (const widget of result) {
      const defaultEntry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === widget.id);
      if (widget.id !== 'stats') {
        expect(widget.colSpan).toBe(defaultEntry?.colSpan);
      }
    }
  });
});
