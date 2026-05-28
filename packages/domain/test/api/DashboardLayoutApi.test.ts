// Tests for DashboardLayoutApi domain shapes.
// Covers: DashboardWidget decode (including required x/y/w/h), DashboardLayout round-trip,
// DASHBOARD_WIDGET_ORDER canonical ordering, DEFAULT_LAYOUT positions.

import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import * as DashboardLayoutApi from '~/api/DashboardLayoutApi.js';

// ---------------------------------------------------------------------------
// DashboardWidget — decode (with x/y/w/h required)
// ---------------------------------------------------------------------------

describe('DashboardWidget — decode', () => {
  it('decodes a fully valid widget {id:"stats",visible:true,x:0,y:0,w:12,h:2}', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'stats',
      visible: true,
      x: 0,
      y: 0,
      w: 12,
      h: 2,
    });
    expect(result.id).toBe('stats');
    expect(result.visible).toBe(true);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.w).toBe(12);
    expect(result.h).toBe(2);
  });

  it('decodes {id:"upcomingEvents",visible:false,x:0,y:2,w:8,h:4} successfully', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'upcomingEvents',
      visible: false,
      x: 0,
      y: 2,
      w: 8,
      h: 4,
    });
    expect(result.id).toBe('upcomingEvents');
    expect(result.visible).toBe(false);
    expect(result.x).toBe(0);
    expect(result.y).toBe(2);
    expect(result.w).toBe(8);
    expect(result.h).toBe(4);
  });

  it('decodes {id:"activity",visible:true,x:8,y:2,w:4,h:2} successfully', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'activity',
      visible: true,
      x: 8,
      y: 2,
      w: 4,
      h: 2,
    });
    expect(result.id).toBe('activity');
    expect(result.visible).toBe(true);
  });

  it('decodes {id:"teamManagement",visible:true,x:8,y:4,w:4,h:2} successfully', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'teamManagement',
      visible: true,
      x: 8,
      y: 4,
      w: 4,
      h: 2,
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
    const input = {
      widgets: [
        { id: 'stats', visible: true, x: 0, y: 0, w: 12, h: 2 },
        { id: 'upcomingEvents', visible: true, x: 0, y: 2, w: 8, h: 4 },
        { id: 'activity', visible: false, x: 8, y: 2, w: 4, h: 2 },
        { id: 'teamManagement', visible: true, x: 8, y: 4, w: 4, h: 2 },
      ],
    };

    const decoded = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardLayout)(input);
    expect(decoded.widgets).toHaveLength(4);

    const encoded = Schema.encodeSync(DashboardLayoutApi.DashboardLayout)(decoded);
    expect(encoded.widgets).toHaveLength(4);
    expect(encoded.widgets[0].id).toBe('stats');
    expect(encoded.widgets[0].visible).toBe(true);
    expect(encoded.widgets[0].x).toBe(0);
    expect(encoded.widgets[0].y).toBe(0);
    expect(encoded.widgets[0].w).toBe(12);
    expect(encoded.widgets[0].h).toBe(2);
    expect(encoded.widgets[1].id).toBe('upcomingEvents');
    expect(encoded.widgets[2].id).toBe('activity');
    expect(encoded.widgets[2].visible).toBe(false);
    expect(encoded.widgets[2].x).toBe(8);
    expect(encoded.widgets[3].id).toBe('teamManagement');
    expect(encoded.widgets[3].x).toBe(8);
    expect(encoded.widgets[3].y).toBe(4);
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

  it('stats is full-width at top (x:0,y:0,w:12,h:2)', () => {
    const stats = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'stats');
    expect(stats).toBeDefined();
    expect(stats?.x).toBe(0);
    expect(stats?.y).toBe(0);
    expect(stats?.w).toBe(12);
    expect(stats?.h).toBe(2);
  });

  it('upcomingEvents spans 8 columns at y:2 (x:0,y:2,w:8,h:4)', () => {
    const ev = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'upcomingEvents');
    expect(ev).toBeDefined();
    expect(ev?.x).toBe(0);
    expect(ev?.y).toBe(2);
    expect(ev?.w).toBe(8);
    expect(ev?.h).toBe(4);
  });

  it('activity spans 4 columns at x:8 (x:8,y:2,w:4,h:2)', () => {
    const act = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'activity');
    expect(act).toBeDefined();
    expect(act?.x).toBe(8);
    expect(act?.y).toBe(2);
    expect(act?.w).toBe(4);
    expect(act?.h).toBe(2);
  });

  it('teamManagement spans 4 columns at x:8,y:4 (x:8,y:4,w:4,h:2)', () => {
    const tm = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'teamManagement');
    expect(tm).toBeDefined();
    expect(tm?.x).toBe(8);
    expect(tm?.y).toBe(4);
    expect(tm?.w).toBe(4);
    expect(tm?.h).toBe(2);
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
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.UpdateDashboardLayoutPayload)({
      widgets: [
        { id: 'stats', visible: true, x: 0, y: 0, w: 12, h: 2 },
        { id: 'activity', visible: false, x: 8, y: 2, w: 4, h: 2 },
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
