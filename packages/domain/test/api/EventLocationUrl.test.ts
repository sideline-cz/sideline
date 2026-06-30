import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as EventApi from '~/api/EventApi.js';

describe('EventLocationUrl — validation', () => {
  it('accepts a valid Google Maps https URL', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventLocationUrl)(
      'https://maps.google.com/foo',
    );
    expect(result).toBe('https://maps.google.com/foo');
  });

  it('accepts a short Google Maps share URL', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventLocationUrl)(
      'https://maps.app.goo.gl/abc',
    );
    expect(result).toBe('https://maps.app.goo.gl/abc');
  });

  it('rejects http:// URLs (https only)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('http://example.com/map'),
    ).toThrow();
  });

  it('rejects ftp:// URLs', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('ftp://example.com/map'),
    ).toThrow();
  });

  it('rejects https://localhost/... (private host)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://localhost/map'),
    ).toThrow();
  });

  it('rejects https://127.0.0.1/... (loopback)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://127.0.0.1/map'),
    ).toThrow();
  });

  it('rejects https://192.168.1.1/... (RFC1918 private range)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://192.168.1.1/map'),
    ).toThrow();
  });

  it('rejects https://10.0.0.5/... (RFC1918 private range)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://10.0.0.5/map'),
    ).toThrow();
  });

  it('rejects https://[::1]/... (IPv6 loopback)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://[::1]/map'),
    ).toThrow();
  });

  it('rejects URLs with userinfo (https://user:pass@example.com/...)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://user:pass@example.com/map'),
    ).toThrow();
  });

  it('rejects URLs longer than 2048 characters', () => {
    const longUrl = `https://example.com/${'a'.repeat(2050)}`;
    expect(() => Schema.decodeUnknownSync(EventApi.EventLocationUrl)(longUrl)).toThrow();
  });

  it('rejects garbage strings that are not URLs', () => {
    expect(() => Schema.decodeUnknownSync(EventApi.EventLocationUrl)('not a url')).toThrow();
  });

  it('rejects URL with literal ">" character (breaks Discord markdown)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://example.com/path?>foo'),
    ).toThrow();
  });

  it('rejects URL with literal space (breaks Discord markdown)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://example.com/foo bar'),
    ).toThrow();
  });

  it('rejects URL with literal "<" character (breaks Discord markdown)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventLocationUrl)('https://example.com/<script>'),
    ).toThrow();
  });
});

describe('isPublicHttpsUrl — predicate', () => {
  it('returns true for a valid public https URL', () => {
    expect(EventApi.isPublicHttpsUrl('https://maps.google.com/foo')).toBe(true);
  });

  it('returns true for a short Google Maps share URL', () => {
    expect(EventApi.isPublicHttpsUrl('https://maps.app.goo.gl/abc')).toBe(true);
  });

  it('returns false for http:// URLs', () => {
    expect(EventApi.isPublicHttpsUrl('http://example.com/map')).toBe(false);
  });

  it('returns false for ftp:// URLs', () => {
    expect(EventApi.isPublicHttpsUrl('ftp://example.com/map')).toBe(false);
  });

  it('returns false for localhost', () => {
    expect(EventApi.isPublicHttpsUrl('https://localhost/map')).toBe(false);
  });

  it('returns false for 127.0.0.1', () => {
    expect(EventApi.isPublicHttpsUrl('https://127.0.0.1/map')).toBe(false);
  });

  it('returns false for 192.168.1.1', () => {
    expect(EventApi.isPublicHttpsUrl('https://192.168.1.1/map')).toBe(false);
  });

  it('returns false for 10.0.0.5', () => {
    expect(EventApi.isPublicHttpsUrl('https://10.0.0.5/map')).toBe(false);
  });

  it('returns false for IPv6 loopback [::1]', () => {
    expect(EventApi.isPublicHttpsUrl('https://[::1]/map')).toBe(false);
  });

  it('returns false for userinfo in URL', () => {
    expect(EventApi.isPublicHttpsUrl('https://user:pass@example.com/map')).toBe(false);
  });

  it('returns false for garbage input', () => {
    expect(EventApi.isPublicHttpsUrl('not a url')).toBe(false);
  });

  // False-positive regression tests: domains that merely start with a private-range prefix
  it('returns true for https://10.example.com/foo (domain starting with "10.", not a private IP)', () => {
    expect(EventApi.isPublicHttpsUrl('https://10.example.com/foo')).toBe(true);
  });

  it('returns true for https://localhost.evil.com/ (domain containing "localhost", not the literal hostname)', () => {
    expect(EventApi.isPublicHttpsUrl('https://localhost.evil.com/')).toBe(true);
  });

  it('returns true for https://172.20.example.com/ (domain starting with "172.20.", not a private IP)', () => {
    expect(EventApi.isPublicHttpsUrl('https://172.20.example.com/')).toBe(true);
  });

  // Issue 4: URLs with unencoded chars that break Discord markdown
  it('returns false for URL with literal ">" character', () => {
    expect(EventApi.isPublicHttpsUrl('https://example.com/path?>foo')).toBe(false);
  });

  it('returns false for URL with literal space', () => {
    expect(EventApi.isPublicHttpsUrl('https://example.com/foo bar')).toBe(false);
  });

  it('returns false for URL with literal "<" character', () => {
    expect(EventApi.isPublicHttpsUrl('https://example.com/<script>')).toBe(false);
  });
});

describe('CreateEventRequest — locationUrl cross-field validation', () => {
  const basePayload = {
    title: 'Training',
    eventType: 'training',
    trainingTypeId: null,
    description: null,
    startAt: '2099-12-31T18:00:00.000Z',
    endAt: null,
    location: 'Main Field',
    ownerGroupId: null,
    memberGroupId: null,
  };

  it('accepts payload with valid location text and valid locationUrl', () => {
    const result = Schema.decodeUnknownSync(EventApi.CreateEventRequest)({
      ...basePayload,
      location: 'Main Field',
      locationUrl: 'https://maps.google.com/foo',
    });
    expect(result.locationUrl).toEqual(Option.some('https://maps.google.com/foo'));
  });

  it('accepts payload with locationUrl: null (Option.none)', () => {
    const result = Schema.decodeUnknownSync(EventApi.CreateEventRequest)({
      ...basePayload,
      locationUrl: null,
    });
    expect(result.locationUrl).toEqual(Option.none());
  });

  it('accepts payload missing locationUrl field (backward compat via OptionFromOptionalNullOr)', () => {
    const result = Schema.decodeUnknownSync(EventApi.CreateEventRequest)(basePayload);
    expect(result.locationUrl).toEqual(Option.none());
  });

  it('rejects payload with locationUrl set but location: null (no location text)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.CreateEventRequest)({
        ...basePayload,
        location: null,
        locationUrl: 'https://maps.google.com/foo',
      }),
    ).toThrow();
  });
});

describe('UpdateEventRequest — locationUrl cross-field validation', () => {
  it('accepts payload omitting both fields (no patch)', () => {
    const result = Schema.decodeUnknownSync(EventApi.UpdateEventRequest)({});
    expect(result.location).toEqual(Option.none());
    expect(result.locationUrl).toEqual(Option.none());
  });

  it('accepts payload with locationUrl set and location text provided', () => {
    const result = Schema.decodeUnknownSync(EventApi.UpdateEventRequest)({
      locationUrl: 'https://maps.google.com/foo',
      location: 'Stadium',
    });
    expect(result.locationUrl).toEqual(Option.some(Option.some('https://maps.google.com/foo')));
    expect(result.location).toEqual(Option.some(Option.some('Stadium')));
  });

  it('rejects payload with locationUrl set and location: null (clearing text while URL is set)', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.UpdateEventRequest)({
        locationUrl: 'https://maps.google.com/foo',
        location: null,
      }),
    ).toThrow();
  });

  it('accepts payload with locationUrl: null (clearing URL only)', () => {
    const result = Schema.decodeUnknownSync(EventApi.UpdateEventRequest)({
      locationUrl: null,
    });
    expect(result.locationUrl).toEqual(Option.some(Option.none()));
  });
});
