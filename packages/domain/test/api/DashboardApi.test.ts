// PR 3b — DashboardUpcomingEvent.startDate: the derived team-local calendar-date
// projection (plan §11.3 boundary table). Same `OptionFromOptionalKey(Schema.String)`
// contract as EventInfo/EventDetail (packages/domain/test/api/EventApi.test.ts) and
// UpcomingEventForUserEntry (packages/domain/test/rpc/event/EventRpcModels.test.ts) —
// see §11.2's boxed warning against a `''` sentinel.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as DashboardApi from '~/api/DashboardApi.js';

const baseWire = {
  eventId: 'evt-1',
  title: 'Practice',
  eventType: 'training',
  startAt: '2026-07-15T12:00:00.000Z',
};

describe('DashboardUpcomingEvent — startDate (PR 3b)', () => {
  it('decodes to Option.none() when the startDate key is entirely absent (old-server skew)', () => {
    const result = Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)(baseWire);
    expect(result.startDate).toStrictEqual(Option.none());
  });

  it('decodes a present startDate to Option.some(string), matching YYYY-MM-DD', () => {
    const result = Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)({
      ...baseWire,
      startDate: '2026-07-15',
    });
    expect(Option.getOrThrow(result.startDate)).toBe('2026-07-15');
    expect(Option.getOrThrow(result.startDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects an explicit null startDate — absent key and null are not the same', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)({
        ...baseWire,
        startDate: null,
      }),
    ).toThrow();
  });

  it("does NOT decode an absent startDate as an empty string (the rejected `''` sentinel design, §11.2)", () => {
    const result = Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)(baseWire);
    expect(result.startDate).not.toStrictEqual(Option.some(''));
  });
});

describe('DashboardUpcomingEvent — allDay (PR 5)', () => {
  it('decodes to false when the allDay key is entirely absent (old-server skew guard)', () => {
    const result = Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)(baseWire);
    expect(result.allDay).toBe(false);
  });

  it('decodes an explicit allDay: true as true', () => {
    const result = Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)({
      ...baseWire,
      allDay: true,
    });
    expect(result.allDay).toBe(true);
  });

  it('round-trips encode -> decode preserving allDay: true', () => {
    const decoded = Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)({
      ...baseWire,
      allDay: true,
      startDate: '2026-07-15',
    });
    const encoded = Schema.encodeSync(DashboardApi.DashboardUpcomingEvent)(decoded);
    const roundTripped = Schema.decodeUnknownSync(DashboardApi.DashboardUpcomingEvent)(encoded);
    expect(roundTripped.allDay).toBe(true);
  });
});

describe('DashboardResponse — todayLocalDate (PR 5, plan §11.5(c))', () => {
  const baseResponse = {
    upcomingEvents: [],
    awaitingRsvp: [],
    activitySummary: {
      currentStreak: 0,
      longestStreak: 0,
      totalActivities: 0,
      totalDurationMinutes: 0,
      leaderboardTotal: 0,
      recentActivityCount: 0,
    },
    myMemberId: 'member-1',
  };

  it('decodes to Option.none() when the key is entirely absent (old-server skew)', () => {
    const result = Schema.decodeUnknownSync(DashboardApi.DashboardResponse)(baseResponse);
    expect(result.todayLocalDate).toStrictEqual(Option.none());
  });

  it('decodes a present todayLocalDate to Option.some(string)', () => {
    const result = Schema.decodeUnknownSync(DashboardApi.DashboardResponse)({
      ...baseResponse,
      todayLocalDate: '2026-07-15',
    });
    expect(Option.getOrThrow(result.todayLocalDate)).toBe('2026-07-15');
  });

  it('rejects an explicit null todayLocalDate — absent key and null are not the same', () => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardApi.DashboardResponse)({
        ...baseResponse,
        todayLocalDate: null,
      }),
    ).toThrow();
  });
});
