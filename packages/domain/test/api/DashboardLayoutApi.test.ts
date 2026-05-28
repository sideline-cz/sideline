// TDD mode — tests written BEFORE any server/web implementation exists.
// The domain package is already built. These tests exercise the already-implemented
// domain exports and will PASS immediately (domain is done). They serve as a
// living contract for the rest of the feature.

import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import * as DashboardLayoutApi from '~/api/DashboardLayoutApi.js';

// ---------------------------------------------------------------------------
// DashboardWidget — decode
// ---------------------------------------------------------------------------

describe('DashboardWidget — decode', () => {
  it('decodes {id:"stats",visible:true} successfully', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'stats',
      visible: true,
    });
    expect(result.id).toBe('stats');
    expect(result.visible).toBe(true);
  });

  it('decodes {id:"upcomingEvents",visible:false} successfully', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'upcomingEvents',
      visible: false,
    });
    expect(result.id).toBe('upcomingEvents');
    expect(result.visible).toBe(false);
  });

  it('decodes {id:"activity",visible:true} successfully', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'activity',
      visible: true,
    });
    expect(result.id).toBe('activity');
    expect(result.visible).toBe(true);
  });

  it('decodes {id:"teamManagement",visible:true} successfully', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
      id: 'teamManagement',
      visible: true,
    });
    expect(result.id).toBe('teamManagement');
    expect(result.visible).toBe(true);
  });

  it('FAILS to decode {id:"awaitingRsvp",visible:true} — not a valid widget id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'awaitingRsvp',
        visible: true,
      }),
    ).toThrow();
  });

  it('FAILS to decode {id:"unknown",visible:true} — unknown id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'unknown',
        visible: true,
      }),
    ).toThrow();
  });

  it('FAILS to decode {id:"stats"} — missing visible field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        id: 'stats',
      }),
    ).toThrow();
  });

  it('FAILS to decode {visible:true} — missing id field', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.DashboardWidget)({
        visible: true,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DashboardLayout — round-trip encode/decode
// ---------------------------------------------------------------------------

describe('DashboardLayout — round-trip encode/decode', () => {
  it('round-trips a DashboardLayout with all 4 valid widgets', () => {
    const input = {
      widgets: [
        { id: 'stats', visible: true },
        { id: 'upcomingEvents', visible: true },
        { id: 'activity', visible: false },
        { id: 'teamManagement', visible: true },
      ],
    };

    const decoded = Schema.decodeUnknownSync(DashboardLayoutApi.DashboardLayout)(input);
    expect(decoded.widgets).toHaveLength(4);

    const encoded = Schema.encodeSync(DashboardLayoutApi.DashboardLayout)(decoded);
    expect(encoded.widgets).toHaveLength(4);
    expect(encoded.widgets[0].id).toBe('stats');
    expect(encoded.widgets[0].visible).toBe(true);
    expect(encoded.widgets[1].id).toBe('upcomingEvents');
    expect(encoded.widgets[2].id).toBe('activity');
    expect(encoded.widgets[2].visible).toBe(false);
    expect(encoded.widgets[3].id).toBe('teamManagement');
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
  it('decodes a valid payload with 2 widgets', () => {
    const result = Schema.decodeUnknownSync(DashboardLayoutApi.UpdateDashboardLayoutPayload)({
      widgets: [
        { id: 'stats', visible: true },
        { id: 'activity', visible: false },
      ],
    });
    expect(result.widgets).toHaveLength(2);
  });

  it('rejects a payload with an invalid widget id', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardLayoutApi.UpdateDashboardLayoutPayload)({
        widgets: [{ id: 'awaitingRsvp', visible: true }],
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
