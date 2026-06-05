import { describe, expect, it } from '@effect/vitest';
import { DateTime, Option, Schema } from 'effect';
import * as EventApi from '~/api/EventApi.js';

describe('EventImageUrl — validation', () => {
  it('accepts a valid public https URL', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventImageUrl)(
      'https://example.com/cover.png',
    );
    expect(result).toBe('https://example.com/cover.png');
  });

  it('accepts an Unsplash URL', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventImageUrl)(
      'https://images.unsplash.com/photo-123?auto=format',
    );
    expect(result).toBe('https://images.unsplash.com/photo-123?auto=format');
  });

  it('accepts a Discord CDN URL', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventImageUrl)(
      'https://cdn.discordapp.com/attachments/123/456/cover.png',
    );
    expect(result).toBe('https://cdn.discordapp.com/attachments/123/456/cover.png');
  });

  it('rejects http:// URLs', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('http://example.com/cover.png'),
    ).toThrow();
  });

  it('rejects IPv6 loopback [::1]', () => {
    expect(() => Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://[::1]/x.png')).toThrow();
  });

  it('rejects IPv6-mapped IPv4 loopback [::ffff:127.0.0.1]', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://[::ffff:127.0.0.1]/x.png'),
    ).toThrow();
  });

  it('rejects unique-local fc00::/7 address [fc00::1]', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://[fc00::1]/x.png'),
    ).toThrow();
  });

  it('rejects unique-local fd00::/7 address [fd00::1]', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://[fd00::1]/x.png'),
    ).toThrow();
  });

  it('rejects link-local address [fe80::1]', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://[fe80::1]/x.png'),
    ).toThrow();
  });

  it('rejects IPv4 loopback 127.0.0.1', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://127.0.0.1/x.png'),
    ).toThrow();
  });

  it('rejects RFC1918 10.x.x.x', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://10.0.0.1/x.png'),
    ).toThrow();
  });

  it('rejects RFC1918 192.168.x.x', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://192.168.1.1/x.png'),
    ).toThrow();
  });

  it('rejects localhost', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventImageUrl)('https://localhost/x.png'),
    ).toThrow();
  });

  it('rejects URLs longer than 2048 characters', () => {
    const longUrl = `https://example.com/${'a'.repeat(2050)}`;
    expect(() => Schema.decodeUnknownSync(EventApi.EventImageUrl)(longUrl)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regression: encoding-direction crash in Schema.check filters
//
// The filters in CreateEventRequest / UpdateEventRequest access `req.locationUrl._tag`
// and `req.location._tag` assuming they are Options. During Schema.encodeSync the
// filter runs on the *encoded* (wire) form where OptionFromOptionalNullOr encodes
// Option.none() as `undefined` (key absent) and OptionFromNullOr encodes Option.none()
// as `null`. Accessing `._tag` on undefined or null throws:
//   TypeError: Cannot read properties of undefined (reading '_tag')
// These tests exercise exactly that code path and MUST FAIL on `main`.
// ---------------------------------------------------------------------------

// Shared fixture — Type-form values (Options) that Schema.encodeSync expects on the input side.
const startAt = DateTime.makeUnsafe('2099-12-31T18:00:00.000Z');

const baseCreatePayload: Schema.Schema.Type<typeof EventApi.CreateEventRequest> = {
  title: 'Training' as typeof Schema.NonEmptyString.Type,
  eventType: 'training' as const,
  trainingTypeId: Option.none(),
  description: Option.none(),
  imageUrl: Option.none(),
  startAt,
  endAt: Option.none(),
  location: Option.none(),
  locationUrl: Option.none(),
  discordChannelId: Option.none(),
  ownerGroupId: Option.none(),
  memberGroupId: Option.none(),
  allDay: false,
};

describe('CreateEventRequest — encoding direction (regression for runtime crash)', () => {
  it('encodes without crashing when location is Some and locationUrl is None', () => {
    // This is the most common create flow — user typed a location, left URL blank.
    // locationUrl encodes to undefined (key absent) via OptionFromOptionalNullOr.
    // The filter must not crash when it encounters undefined instead of an Option.
    const payload: Schema.Schema.Type<typeof EventApi.CreateEventRequest> = {
      ...baseCreatePayload,
      location: Option.some('Stadium'),
      locationUrl: Option.none(),
    };
    const encoded = Schema.encodeSync(EventApi.CreateEventRequest)(payload);
    expect(encoded.location).toBe('Stadium');
    expect('locationUrl' in encoded).toBe(false); // OptionFromOptionalNullOr + none = key absent
  });

  it('encodes without crashing when both location and locationUrl are None', () => {
    // Typical online-only event — no location text, no URL.
    // Both fields hit the "undefined / null" code path during encoding.
    const payload: Schema.Schema.Type<typeof EventApi.CreateEventRequest> = {
      ...baseCreatePayload,
      location: Option.none(),
      locationUrl: Option.none(),
    };
    const encoded = Schema.encodeSync(EventApi.CreateEventRequest)(payload);
    expect(encoded.location).toBeNull(); // OptionFromNullOr + none = null
    expect('locationUrl' in encoded).toBe(false); // OptionFromOptionalNullOr + none = key absent
  });

  it('encodes without crashing when both location and locationUrl are Some', () => {
    // User provided both — valid case, should encode successfully.
    const payload: Schema.Schema.Type<typeof EventApi.CreateEventRequest> = {
      ...baseCreatePayload,
      location: Option.some('Stadium'),
      locationUrl: Option.some('https://maps.google.com/foo'),
    };
    const encoded = Schema.encodeSync(EventApi.CreateEventRequest)(payload);
    expect(encoded.location).toBe('Stadium');
    expect(encoded.locationUrl).toBe('https://maps.google.com/foo');
  });

  it('throws a validation error (not a crash) when locationUrl is Some but location is None', () => {
    // The cross-field rule is: locationUrl requires location text.
    // This should throw a Schema ParseError, NOT a TypeError about ._tag.
    const payload: Schema.Schema.Type<typeof EventApi.CreateEventRequest> = {
      ...baseCreatePayload,
      location: Option.none(),
      locationUrl: Option.some('https://maps.google.com/foo'),
    };
    expect(() => Schema.encodeSync(EventApi.CreateEventRequest)(payload)).toThrow(
      /Location URL requires location text/,
    );
  });
});

describe('UpdateEventRequest — encoding direction (regression for runtime crash)', () => {
  // In the Update schema every field is Option<T> where Option.none() means
  // "field absent from patch" and Option.some(v) means "field is in the patch".
  // For nullable inner fields the inner shape is Option<U> as well.

  const emptyPatch: Schema.Schema.Type<typeof EventApi.UpdateEventRequest> = {
    title: Option.none(),
    eventType: Option.none(),
    trainingTypeId: Option.none(),
    description: Option.none(),
    imageUrl: Option.none(),
    startAt: Option.none(),
    endAt: Option.none(),
    location: Option.none(),
    locationUrl: Option.none(),
    discordChannelId: Option.none(),
    ownerGroupId: Option.none(),
    memberGroupId: Option.none(),
    allDay: Option.none(),
  };

  it('case A: empty patch encodes without crashing — all keys absent in output', () => {
    // All outer Options are none → every field encodes as undefined (key absent).
    // The filter must not crash when it sees undefined for location / locationUrl.
    const encoded = Schema.encodeSync(EventApi.UpdateEventRequest)(emptyPatch);
    expect(Object.keys(encoded)).toHaveLength(0);
  });

  it('case B: form-shaped patch (every field Option.some(Option.none())) encodes without crashing', () => {
    // This mirrors what the web client sends on a full-form Update submission where
    // the user clears all nullable fields. This is the exact regression case reported.
    const patch: Schema.Schema.Type<typeof EventApi.UpdateEventRequest> = {
      title: Option.none(), // title is OptionFromOptional(NonEmptyString), not bi-level
      eventType: Option.none(),
      trainingTypeId: Option.some(Option.none()),
      description: Option.some(Option.none()),
      imageUrl: Option.some(Option.none()),
      startAt: Option.none(),
      endAt: Option.some(Option.none()),
      location: Option.some(Option.none()),
      locationUrl: Option.some(Option.none()),
      discordChannelId: Option.some(Option.none()),
      ownerGroupId: Option.some(Option.none()),
      memberGroupId: Option.some(Option.none()),
      allDay: Option.none(),
    };
    const encoded = Schema.encodeSync(EventApi.UpdateEventRequest)(patch);
    // location and locationUrl should both be present as null in the encoded form
    expect(encoded.location).toBeNull();
    expect(encoded.locationUrl).toBeNull();
  });

  it('case C: setting both location and locationUrl succeeds', () => {
    const patch: Schema.Schema.Type<typeof EventApi.UpdateEventRequest> = {
      ...emptyPatch,
      location: Option.some(Option.some('Stadium')),
      locationUrl: Option.some(Option.some('https://maps.google.com/foo')),
    };
    const encoded = Schema.encodeSync(EventApi.UpdateEventRequest)(patch);
    expect(encoded.location).toBe('Stadium');
    expect(encoded.locationUrl).toBe('https://maps.google.com/foo');
  });

  it('case D: setting locationUrl while clearing location (Some(None)) rejects with validation error', () => {
    // This is the business rule: you cannot have a URL without a location text.
    const patch: Schema.Schema.Type<typeof EventApi.UpdateEventRequest> = {
      ...emptyPatch,
      location: Option.some(Option.none()), // clearing the location text
      locationUrl: Option.some(Option.some('https://maps.google.com/foo')), // setting a URL
    };
    expect(() => Schema.encodeSync(EventApi.UpdateEventRequest)(patch)).toThrow(
      /Location URL requires location text/,
    );
  });

  it('case E: setting locationUrl while location is absent from patch succeeds', () => {
    // location is Option.none() = not in patch at all (preserves existing DB value).
    // locationUrl is being set — this is allowed (the existing location text is preserved).
    const patch: Schema.Schema.Type<typeof EventApi.UpdateEventRequest> = {
      ...emptyPatch,
      location: Option.none(), // absent from patch
      locationUrl: Option.some(Option.some('https://maps.google.com/foo')),
    };
    const encoded = Schema.encodeSync(EventApi.UpdateEventRequest)(patch);
    expect(encoded.locationUrl).toBe('https://maps.google.com/foo');
    expect('location' in encoded).toBe(false); // absent from patch → key absent in wire form
  });

  it('case F: clearing locationUrl alone succeeds — encoded value is null', () => {
    const patch: Schema.Schema.Type<typeof EventApi.UpdateEventRequest> = {
      ...emptyPatch,
      locationUrl: Option.some(Option.none()), // clear the URL
    };
    const encoded = Schema.encodeSync(EventApi.UpdateEventRequest)(patch);
    expect(encoded.locationUrl).toBeNull();
  });
});
