// TDD mode — tests written BEFORE the normalizeWidgets implementation exists.
// These tests WILL FAIL until the developer implements:
//   applications/server/src/api/dashboard-layout.ts
//   (exports `normalizeWidgets(input: ReadonlyArray<DashboardWidget>): ReadonlyArray<DashboardWidget>`)

import { describe, expect, it } from '@effect/vitest';
import { DashboardLayoutApi } from '@sideline/domain';
import { normalizeWidgets } from '~/api/dashboard-layout.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const w = (
  id: DashboardLayoutApi.DashboardWidgetId,
  visible: boolean,
): DashboardLayoutApi.DashboardWidget => new DashboardLayoutApi.DashboardWidget({ id, visible });

// ---------------------------------------------------------------------------
// normalizeWidgets
// ---------------------------------------------------------------------------

describe('normalizeWidgets — empty input', () => {
  it('empty [] → all 4 canonical widgets visible in canonical order', () => {
    const result = normalizeWidgets([]);
    expect(result).toHaveLength(4);
    expect(result[0].id).toBe('stats');
    expect(result[1].id).toBe('upcomingEvents');
    expect(result[2].id).toBe('activity');
    expect(result[3].id).toBe('teamManagement');
    for (const widget of result) {
      expect(widget.visible).toBe(true);
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
  it('[{id:"teamManagement",visible:false}] → teamManagement first (hidden, preserved) then other 3 appended visible in canonical order', () => {
    const input = [w('teamManagement', false)];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(4);
    // First: the given widget, hidden
    expect(result[0].id).toBe('teamManagement');
    expect(result[0].visible).toBe(false);
    // Appended in canonical order: stats, upcomingEvents, activity
    expect(result[1].id).toBe('stats');
    expect(result[1].visible).toBe(true);
    expect(result[2].id).toBe('upcomingEvents');
    expect(result[2].visible).toBe(true);
    expect(result[3].id).toBe('activity');
    expect(result[3].visible).toBe(true);
  });

  it('[stats, activity] → stats first, activity second, upcomingEvents + teamManagement appended visible', () => {
    const input = [w('stats', false), w('activity', false)];
    const result = normalizeWidgets(input);
    expect(result).toHaveLength(4);
    expect(result[0].id).toBe('stats');
    expect(result[0].visible).toBe(false);
    expect(result[1].id).toBe('activity');
    expect(result[1].visible).toBe(false);
    // Appended in canonical order
    expect(result[2].id).toBe('upcomingEvents');
    expect(result[2].visible).toBe(true);
    expect(result[3].id).toBe('teamManagement');
    expect(result[3].visible).toBe(true);
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
      { id: 'awaitingRsvp', visible: true } as unknown as DashboardLayoutApi.DashboardWidget,
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
