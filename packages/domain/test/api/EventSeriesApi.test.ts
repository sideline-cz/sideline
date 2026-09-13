// Regression tests for the encoding-direction crash in EventSeriesApi Schema.check filters.
//
// The filters in CreateEventSeriesRequest / UpdateEventSeriesRequest access
// `req.locationUrl._tag` and `req.location._tag` directly. During Schema.encodeSync the
// filter runs on the *encoded* (wire) form where OptionFromOptionalNullOr encodes
// Option.none() as `undefined` (key absent) and OptionFromNullOr encodes Option.none()
// as `null`. Accessing `._tag` on undefined or null throws:
//   TypeError: Cannot read properties of undefined (reading '_tag')
//
// These tests exercise exactly that code path and MUST FAIL on `main`.
// After the fix (filter inspects Type-form, not Encoded-form), they should pass.

import { describe, expect, it } from '@effect/vitest';
import { DateTime, Option, Schema } from 'effect';
import * as EventSeriesApi from '~/api/EventSeriesApi.js';

// DaysOfWeek is Schema.Array(DayOfWeek).pipe(isMinLength(1), isMaxLength(7))
// DayOfWeek is Schema.Int.pipe(isBetween(0, 6)).  Monday=1, so [1] is a valid single-day array.
// Cast via unknown to satisfy the branded DayOfWeek constraint in test code.
const DAYS_OF_WEEK = [1] as unknown as Schema.Schema.Type<
  typeof import('~/models/EventSeries.js').DaysOfWeek
>;

const startDate = DateTime.makeUnsafe('2099-12-31T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Shared base fixture for CreateEventSeriesRequest
// ---------------------------------------------------------------------------
const baseCreateSeriesPayload: Schema.Schema.Type<typeof EventSeriesApi.CreateEventSeriesRequest> =
  {
    title: 'Weekly Training' as typeof Schema.NonEmptyString.Type,
    trainingTypeId: Option.none(),
    description: Option.none(),
    frequency: 'weekly' as const,
    daysOfWeek: DAYS_OF_WEEK,
    startDate,
    endDate: Option.none(),
    startTime: '18:00',
    endTime: Option.none(),
    location: Option.none(),
    locationUrl: Option.none(),
    ownerGroupId: Option.none(),
    memberGroupId: Option.none(),
    timesAreTeamLocal: false,
  };

// ---------------------------------------------------------------------------
// CreateEventSeriesRequest — encoding direction
// ---------------------------------------------------------------------------

describe('CreateEventSeriesRequest — encoding direction (regression for runtime crash)', () => {
  it('encodes without crashing when location is Some and locationUrl is None', () => {
    // Most common create flow — user typed a location, left URL blank.
    // locationUrl encodes to undefined (key absent) via OptionFromOptionalNullOr.
    // The filter must not crash when it encounters undefined instead of an Option.
    const payload: Schema.Schema.Type<typeof EventSeriesApi.CreateEventSeriesRequest> = {
      ...baseCreateSeriesPayload,
      location: Option.some('Stadium'),
      locationUrl: Option.none(),
    };
    const encoded = Schema.encodeSync(EventSeriesApi.CreateEventSeriesRequest)(payload);
    expect(encoded.location).toBe('Stadium');
    expect('locationUrl' in encoded).toBe(false); // OptionFromOptionalNullOr + none = key absent
  });

  it('encodes without crashing when both location and locationUrl are None', () => {
    // locationUrl encodes to undefined (key absent) via OptionFromOptionalNullOr.
    // location encodes to null via OptionFromNullOr.
    // The filter must not crash when it encounters these raw encoded values.
    const payload: Schema.Schema.Type<typeof EventSeriesApi.CreateEventSeriesRequest> = {
      ...baseCreateSeriesPayload,
      location: Option.none(),
      locationUrl: Option.none(),
    };
    const encoded = Schema.encodeSync(EventSeriesApi.CreateEventSeriesRequest)(payload);
    expect(encoded.location).toBeNull();
    expect('locationUrl' in encoded).toBe(false);
  });

  it('encodes without crashing when locationUrl is Some and location is Some', () => {
    // Valid case — both provided. The filter should pass.
    const payload: Schema.Schema.Type<typeof EventSeriesApi.CreateEventSeriesRequest> = {
      ...baseCreateSeriesPayload,
      location: Option.some('Training Ground'),
      locationUrl: Option.some('https://maps.google.com/foo'),
    };
    const encoded = Schema.encodeSync(EventSeriesApi.CreateEventSeriesRequest)(payload);
    expect(encoded.location).toBe('Training Ground');
    expect(encoded.locationUrl).toBe('https://maps.google.com/foo');
  });

  it('throws a validation error (not a crash) when locationUrl is Some but location is None', () => {
    // The cross-field rule: locationUrl requires location text.
    // Must throw a ParseError with the human-readable message, not a TypeError.
    const payload: Schema.Schema.Type<typeof EventSeriesApi.CreateEventSeriesRequest> = {
      ...baseCreateSeriesPayload,
      location: Option.none(),
      locationUrl: Option.some('https://maps.google.com/foo'),
    };
    expect(() => Schema.encodeSync(EventSeriesApi.CreateEventSeriesRequest)(payload)).toThrow(
      /Location URL requires location text/,
    );
  });
});

// ---------------------------------------------------------------------------
// UpdateEventSeriesRequest — encoding direction
// ---------------------------------------------------------------------------

// In UpdateEventSeriesRequest every field except `timesAreTeamLocal` is OptionFromOptional(T).
// Option.none() = field absent from patch (encodes as key-absent).
// Option.some(v) = field is in the patch.
// For nullable inner fields, v is itself an Option<U>:
//   Option.some(Option.none()) = clearing the field (encodes as null)
//   Option.some(Option.some(v)) = setting to v (encodes as v)
// `timesAreTeamLocal` is a plain `Schema.Boolean` (withDecodingDefaultKey), not Option-wrapped,
// so it always encodes onto the wire, even for an otherwise-empty patch — the client always
// declares the dialect of whatever times it is (not) sending.

const emptySeriesPatch: Schema.Schema.Type<typeof EventSeriesApi.UpdateEventSeriesRequest> = {
  title: Option.none(),
  trainingTypeId: Option.none(),
  description: Option.none(),
  daysOfWeek: Option.none(),
  startTime: Option.none(),
  endTime: Option.none(),
  location: Option.none(),
  locationUrl: Option.none(),
  endDate: Option.none(),
  ownerGroupId: Option.none(),
  memberGroupId: Option.none(),
  timesAreTeamLocal: false,
};

describe('UpdateEventSeriesRequest — encoding direction (regression for runtime crash)', () => {
  it('empty patch encodes without crashing — all Option-wrapped keys absent in output', () => {
    // All outer Options are none → every Option-wrapped field absent in wire form.
    // `timesAreTeamLocal` is not Option-wrapped, so it always encodes.
    // The filter must not crash when it sees undefined for location / locationUrl.
    const encoded = Schema.encodeSync(EventSeriesApi.UpdateEventSeriesRequest)(emptySeriesPatch);
    expect(Object.keys(encoded)).toEqual(['timesAreTeamLocal']);
    expect(encoded.timesAreTeamLocal).toBe(false);
  });

  it('form-shaped patch (every nullable field Option.some(Option.none())) encodes without crashing', () => {
    // Mirrors a web-client Update submission where all nullable fields are cleared.
    // This is the exact regression case: locationUrl and location both encode to null,
    // and the filter must not try to access .._tag on null.
    const patch: Schema.Schema.Type<typeof EventSeriesApi.UpdateEventSeriesRequest> = {
      title: Option.none(), // NonEmptyString field — only outer Option
      trainingTypeId: Option.some(Option.none()),
      description: Option.some(Option.none()),
      daysOfWeek: Option.none(), // DaysOfWeek is not nullable — skip
      startTime: Option.none(), // String field — only outer Option
      endTime: Option.some(Option.none()),
      location: Option.some(Option.none()),
      locationUrl: Option.some(Option.none()),
      endDate: Option.some(Option.none()),
      ownerGroupId: Option.some(Option.none()),
      memberGroupId: Option.some(Option.none()),
      timesAreTeamLocal: false,
    };
    const encoded = Schema.encodeSync(EventSeriesApi.UpdateEventSeriesRequest)(patch);
    expect(encoded.location).toBeNull();
    expect(encoded.locationUrl).toBeNull();
  });

  it('setting both location and locationUrl succeeds', () => {
    const patch: Schema.Schema.Type<typeof EventSeriesApi.UpdateEventSeriesRequest> = {
      ...emptySeriesPatch,
      location: Option.some(Option.some('Training Ground')),
      locationUrl: Option.some(Option.some('https://maps.google.com/foo')),
    };
    const encoded = Schema.encodeSync(EventSeriesApi.UpdateEventSeriesRequest)(patch);
    expect(encoded.location).toBe('Training Ground');
    expect(encoded.locationUrl).toBe('https://maps.google.com/foo');
  });

  it('setting locationUrl while clearing location (Some(None)) rejects with validation error', () => {
    // Business rule: cannot set a URL without location text.
    const patch: Schema.Schema.Type<typeof EventSeriesApi.UpdateEventSeriesRequest> = {
      ...emptySeriesPatch,
      location: Option.some(Option.none()), // clearing location text
      locationUrl: Option.some(Option.some('https://maps.google.com/foo')), // setting URL
    };
    expect(() => Schema.encodeSync(EventSeriesApi.UpdateEventSeriesRequest)(patch)).toThrow(
      /Location URL requires location text/,
    );
  });

  it('setting locationUrl while location is absent from patch succeeds', () => {
    // location = Option.none() means "not in this patch" (DB value preserved).
    // Setting a URL is allowed when location is merely absent (not being cleared).
    const patch: Schema.Schema.Type<typeof EventSeriesApi.UpdateEventSeriesRequest> = {
      ...emptySeriesPatch,
      location: Option.none(), // absent from patch
      locationUrl: Option.some(Option.some('https://maps.google.com/foo')),
    };
    const encoded = Schema.encodeSync(EventSeriesApi.UpdateEventSeriesRequest)(patch);
    expect(encoded.locationUrl).toBe('https://maps.google.com/foo');
    expect('location' in encoded).toBe(false);
  });

  it('clearing locationUrl alone succeeds — encoded value is null', () => {
    const patch: Schema.Schema.Type<typeof EventSeriesApi.UpdateEventSeriesRequest> = {
      ...emptySeriesPatch,
      locationUrl: Option.some(Option.none()),
    };
    const encoded = Schema.encodeSync(EventSeriesApi.UpdateEventSeriesRequest)(patch);
    expect(encoded.locationUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// timesAreTeamLocal — decoding direction (Release N, plan §N.3 / test spec §N.d.6)
// ---------------------------------------------------------------------------
//
// `timesAreTeamLocal` is `Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false))`,
// NOT `Schema.OptionFromOptional` — the idiom the plan documents as the one that makes an
// absent key decode to a plain default value rather than `Option.none()`, `undefined`, or a
// decode failure. This is what makes a `v0.37.2` wire payload (built before this flag existed
// at all, so it never sends the key) safe to decode: the field materializes as `false`, the
// "UTC time-of-day" dialect every pre-#650 client always meant.

describe('CreateEventSeriesRequest / UpdateEventSeriesRequest — timesAreTeamLocal decoding default', () => {
  it('CreateEventSeriesRequest: a wire payload omitting timesAreTeamLocal (the v0.37.2 shape) decodes to false — not undefined, and without throwing', () => {
    const encoded = Schema.encodeSync(EventSeriesApi.CreateEventSeriesRequest)(
      baseCreateSeriesPayload,
    );
    expect('timesAreTeamLocal' in encoded).toBe(true);
    // No cast (`as Record<string, unknown>`) needed to drop the key: `encoded`'s own type
    // already requires `timesAreTeamLocal` as an own property, so `Object.entries`/
    // `Object.fromEntries` — both untyped-key-safe — build the v0.37.2 wire shape instead.
    const wire = Object.fromEntries(
      Object.entries(encoded).filter(([key]) => key !== 'timesAreTeamLocal'),
    );

    let decoded: Schema.Schema.Type<typeof EventSeriesApi.CreateEventSeriesRequest> | undefined;
    expect(() => {
      decoded = Schema.decodeUnknownSync(EventSeriesApi.CreateEventSeriesRequest)(wire);
    }).not.toThrow();
    expect(decoded?.timesAreTeamLocal).toBe(false);
    expect(decoded?.timesAreTeamLocal).not.toBeUndefined();
  });

  it('UpdateEventSeriesRequest: a wire payload omitting timesAreTeamLocal (the v0.37.2 shape) decodes to false — not undefined, and without throwing', () => {
    const encoded = Schema.encodeSync(EventSeriesApi.UpdateEventSeriesRequest)(emptySeriesPatch);
    expect('timesAreTeamLocal' in encoded).toBe(true);
    const wire = Object.fromEntries(
      Object.entries(encoded).filter(([key]) => key !== 'timesAreTeamLocal'),
    );

    let decoded: Schema.Schema.Type<typeof EventSeriesApi.UpdateEventSeriesRequest> | undefined;
    expect(() => {
      decoded = Schema.decodeUnknownSync(EventSeriesApi.UpdateEventSeriesRequest)(wire);
    }).not.toThrow();
    expect(decoded?.timesAreTeamLocal).toBe(false);
    expect(decoded?.timesAreTeamLocal).not.toBeUndefined();
  });
});
