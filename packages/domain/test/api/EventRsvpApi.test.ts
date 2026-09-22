// `docs/plans/rsvp-maybe-restore.md` — `EventRsvpDetail.myResponse` and
// `RsvpEntry.response` widen to the full `RsvpResponse` union (the legacy
// `LegacyRsvpResponse` restriction is deleted), and `EventRsvpDetail` gains
// `comingLaterCount` as its own bucket, split from `maybeCount`.

import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { EventRsvpDetail, RsvpEntry } from '~/api/EventRsvpApi.js';

const baseDetailWire = {
  myResponse: null,
  myMessage: null,
  rsvps: [],
  yesCount: 0,
  noCount: 0,
  maybeCount: 0,
  canRsvp: true,
  minPlayersThreshold: 0,
};

describe('EventRsvpDetail — coming_later widening (rsvp-maybe-restore)', () => {
  it('decodes myResponse: "coming_later" (previously a decode failure)', () => {
    const result = Schema.decodeUnknownSync(EventRsvpDetail)({
      ...baseDetailWire,
      myResponse: 'coming_later',
    });
    expect(result.myResponse._tag).toBe('Some');
    if (result.myResponse._tag === 'Some') {
      expect(result.myResponse.value).toBe('coming_later');
    }
  });

  it('decodes myResponse: "maybe" as its own distinct literal', () => {
    const result = Schema.decodeUnknownSync(EventRsvpDetail)({
      ...baseDetailWire,
      myResponse: 'maybe',
    });
    expect(result.myResponse._tag).toBe('Some');
    if (result.myResponse._tag === 'Some') {
      expect(result.myResponse.value).toBe('maybe');
    }
  });

  it('comingLaterCount defaults to 0 when the key is absent (rolling-deploy skew)', () => {
    const result = Schema.decodeUnknownSync(EventRsvpDetail)(baseDetailWire);
    expect(result.comingLaterCount).toBe(0);
  });

  it('comingLaterCount decodes the present value independently of maybeCount', () => {
    const result = Schema.decodeUnknownSync(EventRsvpDetail)({
      ...baseDetailWire,
      maybeCount: 2,
      comingLaterCount: 4,
    });
    expect(result.maybeCount).toBe(2);
    expect(result.comingLaterCount).toBe(4);
  });
});

describe('RsvpEntry — decodes response: "coming_later"', () => {
  const baseEntryWire = {
    teamMemberId: 'member-1',
    memberName: null,
    username: null,
    message: null,
    displayName: 'Alice',
  };

  it('decodes response: "coming_later"', () => {
    const result = Schema.decodeUnknownSync(RsvpEntry)({
      ...baseEntryWire,
      response: 'coming_later',
    });
    expect(result.response).toBe('coming_later');
  });

  it('decodes response: "maybe" as its own distinct literal', () => {
    const result = Schema.decodeUnknownSync(RsvpEntry)({
      ...baseEntryWire,
      response: 'maybe',
    });
    expect(result.response).toBe('maybe');
  });
});
