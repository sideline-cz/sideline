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
