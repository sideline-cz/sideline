// Tests for DashboardLayoutApi domain shapes.
// Covers: DashboardWidget decode (including required x/y/w/h), DashboardLayout round-trip,
// DASHBOARD_WIDGET_ORDER canonical ordering, DEFAULT_LAYOUT positions.

import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import * as DashboardLayoutApi from '~/api/DashboardLayoutApi.js';

/** Look up a DEFAULT_LAYOUT entry by id; throws if missing (keeps tests strict). */
function defaultEntry(
  id: DashboardLayoutApi.DashboardWidgetId,
): DashboardLayoutApi.DefaultLayoutEntry {
  const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === id);
  if (!entry) throw new Error(`DEFAULT_LAYOUT missing entry for ${id}`);
  return entry;
}

// ---------------------------------------------------------------------------
// DashboardWidget — decode (with x/y/w/h required)
// ---------------------------------------------------------------------------

describe('DashboardWidget — decode', () => {
  it('decodes a fully valid widget using DEFAULT_LAYOUT stats entry', () => {
    const entry = defaultEntry('stats');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'stats',
      visible: true,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
    });
    expect(result.id).toBe('stats');
    expect(result.visible).toBe(true);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
    expect(result.w).toBe(entry.w);
    expect(result.h).toBe(entry.h);
  });

  it('decodes {id:"upcomingEvents"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('upcomingEvents');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'upcomingEvents',
      visible: false,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
    });
    expect(result.id).toBe('upcomingEvents');
    expect(result.visible).toBe(false);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
    expect(result.w).toBe(entry.w);
    expect(result.h).toBe(entry.h);
  });

  it('decodes {id:"activity"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('activity');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'activity',
      visible: true,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
    });
    expect(result.id).toBe('activity');
    expect(result.visible).toBe(true);
  });

  it('decodes {id:"teamManagement"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('teamManagement');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'teamManagement',
      visible: true,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
    });
    expect(result.id).toBe('teamManagement');
    expect(result.visible).toBe(true);
  });

  it('FAILS to decode {id:"awaitingRsvp",visible:true,...} — not a valid widget id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'awaitingRsvp',
        visible: true,
        x: 0,
        y: 0,
        w: 12,
        h: 2,
      }),
    ).toThrow();
  });

  it('FAILS to decode {id:"unknown",visible:true,...} — unknown id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'unknown',
        visible: true,
        x: 0,
        y: 0,
        w: 12,
        h: 2,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing x field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        y: 0,
        w: 12,
        h: 2,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing y field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        x: 0,
        w: 12,
        h: 2,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing w field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        x: 0,
        y: 0,
        h: 2,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing h field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        x: 0,
        y: 0,
        w: 12,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing visible field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        x: 0,
        y: 0,
        w: 12,
        h: 2,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing id field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        visible: true,
        x: 0,
        y: 0,
        w: 12,
        h: 2,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DashboardLayout — round-trip encode/decode
// ---------------------------------------------------------------------------

describe('DashboardLayout — round-trip encode/decode', () => {
  it('round-trips a DashboardLayout with all 4 valid widgets including x/y/w/h', () => {
    // Use DEFAULT_LAYOUT values so the test stays in sync with the canonical defaults
    const entries = DashboardLayoutApi.DEFAULT_LAYOUT;
    const input = {
      widgets: entries.map((e, idx) => ({
        id: e.id,
        visible: idx !== 2, // activity hidden for variety
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
      })),
    };

    const decoded = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardLayout)(input);
    expect(decoded.widgets).toHaveLength(4);

    const encoded = Schema.encodeSync(DashboardLayoutApi.DashboardLayout)(decoded);
    expect(encoded.widgets).toHaveLength(4);
    expect(encoded.widgets[0].id).toBe('stats');
    expect(encoded.widgets[0].visible).toBe(true);
    expect(encoded.widgets[0].x).toBe(entries[0].x);
    expect(encoded.widgets[0].y).toBe(entries[0].y);
    expect(encoded.widgets[0].w).toBe(entries[0].w);
    expect(encoded.widgets[0].h).toBe(entries[0].h);
    expect(encoded.widgets[1].id).toBe('upcomingEvents');
    expect(encoded.widgets[2].id).toBe('activity');
    expect(encoded.widgets[2].visible).toBe(false);
    expect(encoded.widgets[2].x).toBe(entries[2].x);
    expect(encoded.widgets[3].id).toBe('teamManagement');
    expect(encoded.widgets[3].x).toBe(entries[3].x);
    expect(encoded.widgets[3].y).toBe(entries[3].y);
  });

  it('round-trips an empty widgets array', () => {
    const input = { widgets: [] };
    const decoded = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardLayout)(input);
    expect(decoded.widgets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DASHBOARD_WIDGET_ORDER — canonical ordering
// ---------------------------------------------------------------------------

describe('DASHBOARD_WIDGET_ORDER', () => {
  it('deep-equals ["stats","upcomingEvents","activity","teamManagement"]', () => {
    expect(DashboardLayoutApi.DASHBOARD_WIDGET_ORDER).toEqual([
      'stats',
      'upcomingEvents',
      'activity',
      'teamManagement',
    ]);
  });

  it('has exactly 4 entries', () => {
    expect(DashboardLayoutApi.DASHBOARD_WIDGET_ORDER).toHaveLength(4);
  });

  it('every entry is a valid DashboardWidgetId', () => {
    for (const id of DashboardLayoutApi.DASHBOARD_WIDGET_ORDER) {
      expect(() =>
        Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidgetId)(id),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_LAYOUT — positions and visibility
// ---------------------------------------------------------------------------

describe('DEFAULT_LAYOUT', () => {
  it('has exactly 4 entries', () => {
    expect(DashboardLayoutApi.DEFAULT_LAYOUT).toHaveLength(4);
  });

  it('stats is full-width at top (x:0,y:0,w:12,h:14)', () => {
    const stats = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'stats');
    expect(stats).toBeDefined();
    expect(stats?.x).toBe(0);
    expect(stats?.y).toBe(0);
    expect(stats?.w).toBe(12);
    expect(stats?.h).toBe(14);
  });

  it('upcomingEvents spans 8 columns at y:14 (x:0,y:14,w:8,h:28)', () => {
    const ev = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'upcomingEvents');
    expect(ev).toBeDefined();
    expect(ev?.x).toBe(0);
    expect(ev?.y).toBe(14);
    expect(ev?.w).toBe(8);
    expect(ev?.h).toBe(28);
  });

  it('activity spans 4 columns at x:8 (x:8,y:14,w:4,h:20)', () => {
    const act = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'activity');
    expect(act).toBeDefined();
    expect(act?.x).toBe(8);
    expect(act?.y).toBe(14);
    expect(act?.w).toBe(4);
    expect(act?.h).toBe(20);
  });

  it('teamManagement spans 4 columns at x:8,y:34 (x:8,y:34,w:4,h:26)', () => {
    const tm = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'teamManagement');
    expect(tm).toBeDefined();
    expect(tm?.x).toBe(8);
    expect(tm?.y).toBe(34);
    expect(tm?.w).toBe(4);
    expect(tm?.h).toBe(26);
  });

  it('all entries are visible by default', () => {
    for (const entry of DashboardLayoutApi.DEFAULT_LAYOUT) {
      expect(entry.visible).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DashboardWidgetId — literal set
// ---------------------------------------------------------------------------

describe('DashboardWidgetId — literal set', () => {
  it('accepts all four valid ids', () => {
    for (const id of ['stats', 'upcomingEvents', 'activity', 'teamManagement']) {
      expect(() =>
        Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidgetId)(id),
      ).not.toThrow();
    }
  });

  it('rejects "banner" — not in the set', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidgetId)('banner'),
    ).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidgetId)('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// UpdateDashboardLayoutPayload — decode
// ---------------------------------------------------------------------------

describe('UpdateDashboardLayoutPayload — decode', () => {
  it('decodes a valid payload with 2 widgets (including x/y/w/h)', () => {
    const statsEntry = defaultEntry('stats');
    const activityEntry = defaultEntry('activity');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.UpdateDashboardLayoutPayload)({
      widgets: [
        {
          id: 'stats',
          visible: true,
          x: statsEntry.x,
          y: statsEntry.y,
          w: statsEntry.w,
          h: statsEntry.h,
        },
        {
          id: 'activity',
          visible: false,
          x: activityEntry.x,
          y: activityEntry.y,
          w: activityEntry.w,
          h: activityEntry.h,
        },
      ],
    });
    expect(result.widgets).toHaveLength(2);
  });

  it('rejects a payload with an invalid widget id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.UpdateDashboardLayoutPayload)({
        widgets: [{ id: 'awaitingRsvp', visible: true, x: 0, y: 0, w: 12, h: 2 }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Forbidden (DashboardLayoutForbidden) tagged error
// ---------------------------------------------------------------------------

describe('Forbidden — tagged error class', () => {
  it('has _tag "DashboardLayoutForbidden"', () => {
    const err = new DashboardLayoutApi.Forbidden();
    expect(err._tag).toBe('DashboardLayoutForbidden');
  });
});
