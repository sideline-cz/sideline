// Tests for DashboardLayoutApi domain shapes.
// Covers: DashboardWidget decode (including required height), DashboardLayout round-trip,
// DASHBOARD_WIDGET_ORDER canonical ordering, DEFAULT_LAYOUT heights.

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
// DashboardWidget — decode (with height required)
// ---------------------------------------------------------------------------

describe('DashboardWidget — decode', () => {
  it('decodes a fully valid widget using DEFAULT_LAYOUT stats entry', () => {
    const entry = defaultEntry('stats');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'stats',
      visible: true,
      height: entry.height,
      colSpan: entry.colSpan,
      x: entry.x,
      y: entry.y,
    });
    expect(result.id).toBe('stats');
    expect(result.visible).toBe(true);
    expect(result.height).toBe(entry.height);
    expect(result.colSpan).toBe(entry.colSpan);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
  });

  it('decodes {id:"upcomingEvents"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('upcomingEvents');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'upcomingEvents',
      visible: false,
      height: entry.height,
      colSpan: entry.colSpan,
      x: entry.x,
      y: entry.y,
    });
    expect(result.id).toBe('upcomingEvents');
    expect(result.visible).toBe(false);
    expect(result.height).toBe(entry.height);
    expect(result.colSpan).toBe(entry.colSpan);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
  });

  it('decodes {id:"activity"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('activity');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'activity',
      visible: true,
      height: entry.height,
      colSpan: entry.colSpan,
      x: entry.x,
      y: entry.y,
    });
    expect(result.id).toBe('activity');
    expect(result.visible).toBe(true);
    expect(result.height).toBe(entry.height);
    expect(result.colSpan).toBe(entry.colSpan);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
  });

  it('decodes {id:"teamManagement"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('teamManagement');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'teamManagement',
      visible: true,
      height: entry.height,
      colSpan: entry.colSpan,
      x: entry.x,
      y: entry.y,
    });
    expect(result.id).toBe('teamManagement');
    expect(result.visible).toBe(true);
    expect(result.height).toBe(entry.height);
    expect(result.colSpan).toBe(entry.colSpan);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
  });

  it('decodes colSpan 1 (minimum valid)', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'stats',
      visible: true,
      height: 140,
      colSpan: 1,
      x: 1,
      y: 1,
    });
    expect(result.colSpan).toBe(1);
  });

  it('decodes colSpan 3 (maximum valid)', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'stats',
      visible: true,
      height: 140,
      colSpan: 3,
      x: 1,
      y: 1,
    });
    expect(result.colSpan).toBe(3);
  });

  it('FAILS to decode when colSpan is 0 (below minimum)', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        height: 140,
        colSpan: 0,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });

  it('FAILS to decode when colSpan is 4 (above maximum)', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        height: 140,
        colSpan: 4,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });

  it('FAILS to decode when colSpan is missing', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        height: 140,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });

  it('decodes {id:"awaitingRsvp"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('awaitingRsvp');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'awaitingRsvp',
      visible: true,
      height: entry.height,
      colSpan: entry.colSpan,
      x: entry.x,
      y: entry.y,
    });
    expect(result.id).toBe('awaitingRsvp');
    expect(result.visible).toBe(true);
    expect(result.height).toBe(entry.height);
    expect(result.colSpan).toBe(entry.colSpan);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
  });

  it('decodes {id:"outstandingPayments"} using DEFAULT_LAYOUT entry successfully', () => {
    const entry = defaultEntry('outstandingPayments');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'outstandingPayments',
      visible: true,
      height: entry.height,
      colSpan: entry.colSpan,
      x: entry.x,
      y: entry.y,
    });
    expect(result.id).toBe('outstandingPayments');
    expect(result.visible).toBe(true);
    expect(result.height).toBe(entry.height);
    expect(result.colSpan).toBe(entry.colSpan);
    expect(result.x).toBe(entry.x);
    expect(result.y).toBe(entry.y);
  });

  it('FAILS to decode {id:"fakeUnknown",visible:true,...} — not a valid widget id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'fakeUnknown',
        visible: true,
        height: 200,
        colSpan: 1,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });

  it('FAILS to decode {id:"unknown",visible:true,...} — unknown id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'unknown',
        visible: true,
        height: 200,
        colSpan: 1,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing height field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        visible: true,
        colSpan: 3,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing visible field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
        height: 140,
        colSpan: 3,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });

  it('FAILS to decode when missing id field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        visible: true,
        height: 140,
        colSpan: 3,
        x: 1,
        y: 1,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DashboardLayout — round-trip encode/decode
// ---------------------------------------------------------------------------

describe('DashboardLayout — round-trip encode/decode', () => {
  it('round-trips a DashboardLayout with all 6 valid widgets including height and colSpan', () => {
    const entries = DashboardLayoutApi.DEFAULT_LAYOUT;
    const input = {
      widgets: entries.map((e, idx) => ({
        id: e.id,
        visible: idx !== 4, // activity hidden for variety
        height: e.height,
        colSpan: e.colSpan,
        x: e.x,
        y: e.y,
      })),
    };

    const decoded = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardLayout)(input);
    expect(decoded.widgets).toHaveLength(6);

    const encoded = Schema.encodeSync(DashboardLayoutApi.DashboardLayout)(decoded);
    expect(encoded.widgets).toHaveLength(6);
    expect(encoded.widgets[0].id).toBe('awaitingRsvp');
    expect(encoded.widgets[0].visible).toBe(true);
    expect(encoded.widgets[0].height).toBe(entries[0].height);
    expect(encoded.widgets[0].colSpan).toBe(entries[0].colSpan);
    expect(encoded.widgets[0].x).toBe(entries[0].x);
    expect(encoded.widgets[0].y).toBe(entries[0].y);
    expect(encoded.widgets[1].id).toBe('outstandingPayments');
    expect(encoded.widgets[1].height).toBe(entries[1].height);
    expect(encoded.widgets[1].colSpan).toBe(entries[1].colSpan);
    expect(encoded.widgets[1].x).toBe(entries[1].x);
    expect(encoded.widgets[1].y).toBe(entries[1].y);
    expect(encoded.widgets[2].id).toBe('stats');
    expect(encoded.widgets[2].visible).toBe(true);
    expect(encoded.widgets[2].height).toBe(entries[2].height);
    expect(encoded.widgets[2].colSpan).toBe(entries[2].colSpan);
    expect(encoded.widgets[2].x).toBe(entries[2].x);
    expect(encoded.widgets[2].y).toBe(entries[2].y);
    expect(encoded.widgets[3].id).toBe('upcomingEvents');
    expect(encoded.widgets[3].height).toBe(entries[3].height);
    expect(encoded.widgets[3].colSpan).toBe(entries[3].colSpan);
    expect(encoded.widgets[3].x).toBe(entries[3].x);
    expect(encoded.widgets[3].y).toBe(entries[3].y);
    expect(encoded.widgets[4].id).toBe('activity');
    expect(encoded.widgets[4].visible).toBe(false);
    expect(encoded.widgets[4].height).toBe(entries[4].height);
    expect(encoded.widgets[4].colSpan).toBe(entries[4].colSpan);
    expect(encoded.widgets[4].x).toBe(entries[4].x);
    expect(encoded.widgets[4].y).toBe(entries[4].y);
    expect(encoded.widgets[5].id).toBe('teamManagement');
    expect(encoded.widgets[5].height).toBe(entries[5].height);
    expect(encoded.widgets[5].colSpan).toBe(entries[5].colSpan);
    expect(encoded.widgets[5].x).toBe(entries[5].x);
    expect(encoded.widgets[5].y).toBe(entries[5].y);
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
  it('deep-equals ["awaitingRsvp","outstandingPayments","stats","upcomingEvents","activity","teamManagement"]', () => {
    expect(DashboardLayoutApi.DASHBOARD_WIDGET_ORDER).toEqual([
      'awaitingRsvp',
      'outstandingPayments',
      'stats',
      'upcomingEvents',
      'activity',
      'teamManagement',
    ]);
  });

  it('has exactly 6 entries', () => {
    expect(DashboardLayoutApi.DASHBOARD_WIDGET_ORDER).toHaveLength(6);
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
// DEFAULT_LAYOUT — heights and visibility
// ---------------------------------------------------------------------------

describe('DEFAULT_LAYOUT', () => {
  it('has exactly 6 entries', () => {
    expect(DashboardLayoutApi.DEFAULT_LAYOUT).toHaveLength(6);
  });

  it('awaitingRsvp has height 80', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'awaitingRsvp');
    expect(entry).toBeDefined();
    expect(entry?.height).toBe(80);
  });

  it('outstandingPayments has height 80', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'outstandingPayments');
    expect(entry).toBeDefined();
    expect(entry?.height).toBe(80);
  });

  it('stats has height 140', () => {
    const stats = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'stats');
    expect(stats).toBeDefined();
    expect(stats?.height).toBe(140);
  });

  it('upcomingEvents has height 280', () => {
    const ev = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'upcomingEvents');
    expect(ev).toBeDefined();
    expect(ev?.height).toBe(280);
  });

  it('activity has height 200', () => {
    const act = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'activity');
    expect(act).toBeDefined();
    expect(act?.height).toBe(200);
  });

  it('teamManagement has height 260', () => {
    const tm = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'teamManagement');
    expect(tm).toBeDefined();
    expect(tm?.height).toBe(260);
  });

  it('all entries are visible by default', () => {
    for (const entry of DashboardLayoutApi.DEFAULT_LAYOUT) {
      expect(entry.visible).toBe(true);
    }
  });

  it('awaitingRsvp has colSpan 3 (full width)', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'awaitingRsvp');
    expect(entry?.colSpan).toBe(3);
  });

  it('outstandingPayments has colSpan 3 (full width)', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'outstandingPayments');
    expect(entry?.colSpan).toBe(3);
  });

  it('stats has colSpan 3 (full width)', () => {
    const stats = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'stats');
    expect(stats?.colSpan).toBe(3);
  });

  it('upcomingEvents has colSpan 2', () => {
    const ev = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'upcomingEvents');
    expect(ev?.colSpan).toBe(2);
  });

  it('activity has colSpan 1', () => {
    const act = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'activity');
    expect(act?.colSpan).toBe(1);
  });

  it('teamManagement has colSpan 1', () => {
    const tm = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'teamManagement');
    expect(tm?.colSpan).toBe(1);
  });

  it('awaitingRsvp has x=1, y=1', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'awaitingRsvp');
    expect(entry?.x).toBe(1);
    expect(entry?.y).toBe(1);
  });

  it('outstandingPayments has x=1, y=2', () => {
    const entry = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'outstandingPayments');
    expect(entry?.x).toBe(1);
    expect(entry?.y).toBe(2);
  });

  it('stats has x=1, y=3', () => {
    const stats = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'stats');
    expect(stats?.x).toBe(1);
    expect(stats?.y).toBe(3);
  });

  it('upcomingEvents has x=1, y=4', () => {
    const ev = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'upcomingEvents');
    expect(ev?.x).toBe(1);
    expect(ev?.y).toBe(4);
  });

  it('activity has x=9, y=4', () => {
    const act = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'activity');
    expect(act?.x).toBe(9);
    expect(act?.y).toBe(4);
  });

  it('teamManagement has x=9, y=5', () => {
    const tm = DashboardLayoutApi.DEFAULT_LAYOUT.find((e) => e.id === 'teamManagement');
    expect(tm?.x).toBe(9);
    expect(tm?.y).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// DashboardWidgetId — literal set
// ---------------------------------------------------------------------------

describe('DashboardWidgetId — literal set', () => {
  it('accepts all six valid ids', () => {
    for (const id of [
      'awaitingRsvp',
      'outstandingPayments',
      'stats',
      'upcomingEvents',
      'activity',
      'teamManagement',
    ]) {
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
  it('decodes a valid payload with 2 widgets (including height and colSpan)', () => {
    const statsEntry = defaultEntry('stats');
    const activityEntry = defaultEntry('activity');
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.UpdateDashboardLayoutPayload)({
      widgets: [
        {
          id: 'stats',
          visible: true,
          height: statsEntry.height,
          colSpan: statsEntry.colSpan,
          x: statsEntry.x,
          y: statsEntry.y,
        },
        {
          id: 'activity',
          visible: false,
          height: activityEntry.height,
          colSpan: activityEntry.colSpan,
          x: activityEntry.x,
          y: activityEntry.y,
        },
      ],
    });
    expect(result.widgets).toHaveLength(2);
  });

  it('rejects a payload with an invalid widget id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.UpdateDashboardLayoutPayload)({
        widgets: [{ id: 'fakeUnknown', visible: true, height: 200, colSpan: 1, x: 1, y: 1 }],
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
