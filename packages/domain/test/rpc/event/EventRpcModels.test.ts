// PR 3b — UpcomingEventForUserEntry.start_date/end_date: the derived team-local
// calendar-date projection that feeds Discord's B0 render (`buildUpcomingEventEmbed`,
// the highest-volume all-day surface in the product — plan §11.1 row B0, §11.3).
//
// Same `Schema.OptionFromOptionalKey(Schema.String)` contract as EventInfo/EventDetail
// (packages/domain/test/api/EventApi.test.ts) — never a plain string with a `''`
// fallback. Precedent in this very class: `my_response_actual` uses the identical
// shape for the identical rolling-deploy reason (doc comment at EventRpcModels.ts:207).

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import { UpcomingEventForUserEntry } from '~/rpc/event/EventRpcModels.js';

const baseWire = {
  event_id: 'evt-1',
  team_id: 'team-1',
  title: 'All-day tournament',
  description: null,
  image_url: null,
  start_at: '2026-07-15T12:00:00.000Z',
  end_at: null,
  location: null,
  location_url: null,
  event_type: 'tournament',
  yes_count: 3,
  no_count: 1,
  maybe_count: 0,
  all_day: true,
  my_response: null,
  my_message: null,
  // my_response_actual intentionally omitted — OptionFromOptionalKey, absent is valid.
};

describe('UpcomingEventForUserEntry — start_date/end_date (PR 3b)', () => {
  it('decodes to Option.none() for both when the keys are entirely absent (old-server skew, §17.1 row 3)', () => {
    const result = Schema.decodeUnknownSync(UpcomingEventForUserEntry)(baseWire);
    expect(result.start_date).toStrictEqual(Option.none());
    expect(result.end_date).toStrictEqual(Option.none());
  });

  it('decodes present start_date/end_date to Option.some(string), matching YYYY-MM-DD', () => {
    const result = Schema.decodeUnknownSync(UpcomingEventForUserEntry)({
      ...baseWire,
      start_date: '2026-07-15',
      end_date: '2026-07-17',
    });
    expect(Option.getOrThrow(result.start_date)).toBe('2026-07-15');
    expect(Option.getOrThrow(result.end_date)).toBe('2026-07-17');
    expect(Option.getOrThrow(result.start_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Option.getOrThrow(result.end_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // end_date is ALWAYS non-NULL by construction once the server sends it at all
  // (§11.4's note: `(COALESCE(e.end_at, e.start_at) AT TIME ZONE …)::date::text`), so a
  // single-day event's end_date equals its start_date rather than being absent.
  it('a single-day all-day event has end_date equal to start_date, not absent, once the server sends both', () => {
    const result = Schema.decodeUnknownSync(UpcomingEventForUserEntry)({
      ...baseWire,
      start_date: '2026-07-15',
      end_date: '2026-07-15',
    });
    expect(Option.getOrThrow(result.start_date)).toBe(Option.getOrThrow(result.end_date));
  });

  it('rejects an explicit null start_date — absent key and null are not the same', () => {
    expect(() =>
      Schema.decodeUnknownSync(UpcomingEventForUserEntry)({
        ...baseWire,
        start_date: null,
      }),
    ).toThrow();
  });

  it("does NOT decode an absent start_date as an empty string (the rejected `''` sentinel design)", () => {
    const result = Schema.decodeUnknownSync(UpcomingEventForUserEntry)(baseWire);
    // §11.4: `discordDateInstant('', fallback)` would quietly return the fallback too,
    // masking the mistake on the bot side as well as the web side (§11.2's box).
    expect(result.start_date).not.toStrictEqual(Option.some(''));
  });
});
