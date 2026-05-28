// Tests for normalizeWidgets in applications/server/src/api/dashboard-layout.ts
//
// normalizeWidgets:
//   - Deduplicates by id (keeps first occurrence)
//   - Drops unknown ids
//   - Appends missing canonical widgets below existing ones (using DEFAULT_LAYOUT positions offset)
//   - Preserves visible:false on existing widgets
//   - Fills in missing position fields with defaults from DEFAULT_LAYOUT

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
    x: entry.x,
    y: entry.y,
    w: entry.w,
    h: entry.h,
  });
};

// ---------------------------------------------------------------------------
// normalizeWidgets
// ---------------------------------------------------------------------------

describe('normalizeWidgets — empty input', () => {
  it('empty [] → all 4 canonical widgets visible with DEFAULT_LAYOUT positions', () => {
    const result = normalizeWidgets([]);
    expect(result).toHaveLength(4);
    expect(result[0].id).toBe('stats');
    expect(result[1].id).toBe('upcomingEvents');
    expect(result[2].id).toBe('activity');
    expect(result[3].id).toBe('teamManagement');
    for (const widget of result) {
      expect(widget.visible).toBe(true);
      expect(typeof widget.x).toBe('number');
      expect(typeof widget.y).toBe('number');
      expect(typeof widget.w).toBe('number');
      expect(typeof widget.h).toBe('number');
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
    ];
    const result = normalizeWidgets(input);
    // All 4 present, no extras appended
    expect(result).toHaveLength(4);
    // Order is preserved from input
    expect(result[0].id).toBe('teamManagement');
    expect(result[1].id).toBe('activity');
    expect(result[2].id).toBe('upcomingEvents');
    expect(result[3].id).toBe('stats');
    // Visibility preserved
    expect(result[0].visible).toBe(true);
    expect(result[1].visible).toBe(false);
    expect(result[3].visible).toBe(false);
  });
});

describe('normalizeWidgets — partial input', () => {
  it('[teamManagement hidden] → first, then other 3 appended visible below existing', () => {
    const input = [w('teamManagement', false)];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(4);
    // First: the given widget, hidden
    expect(result[0].id).toBe('teamManagement');
    expect(result[0].visible).toBe(false);
    // Appended missing: stats, upcomingEvents, activity (from DEFAULT_LAYOUT order)
    const appendedIds = result.slice(1).map((r) => r.id);
    expect(appendedIds).toContain('stats');
    expect(appendedIds).toContain('upcomingEvents');
    expect(appendedIds).toContain('activity');
    // Appended are visible
    for (const widget of result.slice(1)) {
      expect(widget.visible).toBe(true);
    }
  });

  it('[stats, activity] → stats first, activity second, upcomingEvents + teamManagement appended visible', () => {
    const input = [w('stats', false), w('activity', false)];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(4);
    expect(result[0].id).toBe('stats');
    expect(result[0].visible).toBe(false);
    expect(result[1].id).toBe('activity');
    expect(result[1].visible).toBe(false);
    // Appended from DEFAULT_LAYOUT order
    const appendedIds = result.slice(2).map((r) => r.id);
    expect(appendedIds).toContain('upcomingEvents');
    expect(appendedIds).toContain('teamManagement');
    for (const widget of result.slice(2)) {
      expect(widget.visible).toBe(true);
    }
  });

  it('appended missing widgets have position fields', () => {
    const input = [w('stats', true)];
    const result = normalizeWidgets(input);
    for (const widget of result) {
      expect(typeof widget.x).toBe('number');
      expect(typeof widget.y).toBe('number');
      expect(typeof widget.w).toBe('number');
      expect(typeof widget.h).toBe('number');
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

  it('all four present but stats duplicated → result length 4, not 5', () => {
    const input = [
      w('stats', true),
      w('upcomingEvents', true),
      w('activity', true),
      w('teamManagement', true),
      w('stats', false),
    ];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(4);
  });
});

describe('normalizeWidgets — drop unknown ids', () => {
  it('input with an invalid id object → dropped, only valid widgets remain', () => {
    // Cast to bypass TypeScript; at runtime normalizeWidgets receives arbitrary data.
    const input = [
      {
        id: 'awaitingRsvp',
        visible: true,
        x: 0,
        y: 0,
        w: 12,
        h: 2,
      } as unknown as DashboardLayoutApi.DashboardWidget,
      w('stats', true),
    ];
    const result = normalizeWidgets(input);
    // 'awaitingRsvp' is not a valid DashboardWidgetId → dropped
    const awaitingEntries = result.filter((r) => r.id === ('awaitingRsvp' as any));
    expect(awaitingEntries).toHaveLength(0);
    // The valid ones (stats) plus the 3 missing appended
    expect(result).toHaveLength(4);
    expect(result.some((r) => r.id === 'stats')).toBe(true);
  });
});

describe('normalizeWidgets — preserves visible:false', () => {
  it('does not force-enable a widget that is explicitly hidden', () => {
    const input = [
      w('stats', false),
      w('upcomingEvents', false),
      w('activity', false),
      w('teamManagement', false),
    ];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(4);
    for (const widget of result) {
      expect(widget.visible).toBe(false);
    }
  });
});

describe('normalizeWidgets — missing position fields filled from DEFAULT_LAYOUT', () => {
  it('fills x/y/w/h from DEFAULT_LAYOUT for widgets missing those fields (legacy)', () => {
    // Simulate a legacy widget missing position fields
    const legacyWidget = {
      id: 'stats' as DashboardLayoutApi.DashboardWidgetId,
      visible: true,
      x: 0,
      y: 0,
      w: 12,
      h: 2,
    } as DashboardLayoutApi.DashboardWidget;
    const result = normalizeWidgets([legacyWidget]);
    const stats = result.find((r) => r.id === 'stats');
    expect(stats).toBeDefined();
    expect(typeof stats?.x).toBe('number');
    expect(typeof stats?.y).toBe('number');
    expect(typeof stats?.w).toBe('number');
    expect(typeof stats?.h).toBe('number');
  });
});
