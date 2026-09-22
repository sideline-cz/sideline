import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as EventApi from '~/api/EventApi.js';
import * as EventTypeApi from '~/api/EventTypeApi.js';
import * as Event from '~/models/Event.js';
import {
  defaultColorForKind,
  EventTypeColor,
  EventTypeKind,
  eventTypeColorHex,
} from '~/models/EventType.js';

// ---------------------------------------------------------------------------
// E1 — eventTypeColorHex totality (both directions)
// ---------------------------------------------------------------------------

describe('eventTypeColorHex', () => {
  it('has exactly one key per EventTypeColor literal, and vice versa', () => {
    const literals = new Set<string>(EventTypeColor.literals);
    const keys = new Set(Object.keys(eventTypeColorHex));

    // Every literal has a hex entry.
    for (const literal of literals) {
      expect(keys.has(literal)).toBe(true);
    }
    // Every hex entry is a valid literal — catches a stray/typo'd key.
    for (const key of keys) {
      expect(literals.has(key)).toBe(true);
    }
    expect(keys.size).toBe(literals.size);
  });

  it('maps every colour to a numeric 24-bit hex value', () => {
    for (const value of Object.values(eventTypeColorHex)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffff);
    }
  });
});

// ---------------------------------------------------------------------------
// E2 — defaultColorForKind totality
// ---------------------------------------------------------------------------

describe('defaultColorForKind', () => {
  it('has exactly one key per EventTypeKind literal', () => {
    const literals = new Set<string>(EventTypeKind.literals);
    const keys = new Set(Object.keys(defaultColorForKind));

    for (const literal of literals) {
      expect(keys.has(literal)).toBe(true);
    }
    for (const key of keys) {
      expect(literals.has(key)).toBe(true);
    }
    expect(keys.size).toBe(literals.size);
  });

  it('maps every kind to a colour that is itself a valid EventTypeColor literal', () => {
    const colorLiterals = new Set<string>(EventTypeColor.literals);
    for (const color of Object.values(defaultColorForKind)) {
      expect(colorLiterals.has(color)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// E3 — Event.EventType.literals is still the historical six-element array,
// in order. ~548 call sites route off this re-export — guard both membership
// and order.
// ---------------------------------------------------------------------------

describe('Event.EventType.literals', () => {
  it('is the historical six-element array, in order', () => {
    expect(Event.EventType.literals).toStrictEqual([
      'training',
      'match',
      'tournament',
      'meeting',
      'social',
      'other',
    ]);
  });
});

// ---------------------------------------------------------------------------
// E4 — CreateEventTypeRequest decode validation
// ---------------------------------------------------------------------------

describe('CreateEventTypeRequest', () => {
  it('decodes a valid payload', () => {
    const result = Schema.decodeUnknownSync(EventTypeApi.CreateEventTypeRequest)({
      name: 'Beach party',
      kind: 'social',
      color: 'pink',
    });
    expect(result.name).toBe('Beach party');
    expect(result.kind).toBe('social');
    expect(result.color).toBe('pink');
  });

  it('rejects an empty name', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventTypeApi.CreateEventTypeRequest)({
        name: '',
        kind: 'training',
        color: 'blue',
      }),
    ).toThrow();
  });

  it('rejects a 51-character name', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventTypeApi.CreateEventTypeRequest)({
        name: 'A'.repeat(51),
        kind: 'training',
        color: 'blue',
      }),
    ).toThrow();
  });

  it('accepts a 50-character name (boundary)', () => {
    const result = Schema.decodeUnknownSync(EventTypeApi.CreateEventTypeRequest)({
      name: 'A'.repeat(50),
      kind: 'training',
      color: 'blue',
    });
    expect(result.name).toHaveLength(50);
  });

  it('rejects an unknown colour', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventTypeApi.CreateEventTypeRequest)({
        name: 'Training',
        kind: 'training',
        color: 'turquoise',
      }),
    ).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventTypeApi.CreateEventTypeRequest)({
        name: 'Training',
        kind: 'practice',
        color: 'blue',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// E5 / E6 — EventInfo decode of the three eventType* fields, all
// OptionFromOptionalKey. A missing key must decode to Option.none() (old
// server, mid rolling-deploy); an explicit `eventTypeName: null` must decode
// to the nested-Option "seeded, un-renamed row" shape, Option.some(Option.none()).
// ---------------------------------------------------------------------------

const baseEventInfoWire = {
  eventId: 'evt-1',
  teamId: 'team-1',
  title: 'Practice',
  eventType: 'training',
  trainingTypeName: null,
  description: null,
  imageUrl: null,
  startAt: '2026-07-15T12:00:00.000Z',
  endAt: null,
  location: null,
  locationUrl: null,
  status: 'active',
  allDay: true,
  seriesId: null,
};

describe('EventInfo — eventTypeId/eventTypeName/eventTypeColor (rolling-deploy skew)', () => {
  it('E5: decodes to Option.none() for all three when the keys are entirely absent (old server)', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventInfo)(baseEventInfoWire);
    expect(result.eventTypeId).toStrictEqual(Option.none());
    expect(result.eventTypeName).toStrictEqual(Option.none());
    expect(result.eventTypeColor).toStrictEqual(Option.none());
  });

  it('E6: decodes eventTypeName: null (a seeded, un-renamed row) to Option.some(Option.none())', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventInfo)({
      ...baseEventInfoWire,
      eventTypeId: '11111111-1111-1111-1111-111111111111',
      eventTypeName: null,
      eventTypeColor: 'blue',
    });
    expect(Option.isSome(result.eventTypeId)).toBe(true);
    expect(Option.getOrThrow(result.eventTypeColor)).toBe('blue');

    // The key IS present (as null), so the outer Option is Some — unlike E5's absent-key
    // case. The inner OptionFromNullOr collapses the `null` to None, carrying the "seeded
    // row, no name yet" signal a reader must render as the kind's default label.
    expect(Option.isSome(result.eventTypeName)).toBe(true);
    if (Option.isSome(result.eventTypeName)) {
      expect(Option.isNone(result.eventTypeName.value)).toBe(true);
    }
  });

  it('a present, non-null eventTypeName decodes to Option.some(Option.some(string))', () => {
    const result = Schema.decodeUnknownSync(EventApi.EventInfo)({
      ...baseEventInfoWire,
      eventTypeId: '11111111-1111-1111-1111-111111111111',
      eventTypeName: 'Trénink',
      eventTypeColor: 'blue',
    });
    expect(Option.isSome(result.eventTypeName)).toBe(true);
    if (Option.isSome(result.eventTypeName)) {
      expect(Option.getOrNull(result.eventTypeName.value)).toBe('Trénink');
    }
  });

  it('an explicit null eventTypeId is a decode error — OptionFromOptionalKey requires the key be absent, not null', () => {
    expect(() =>
      Schema.decodeUnknownSync(EventApi.EventInfo)({
        ...baseEventInfoWire,
        eventTypeId: null,
      }),
    ).toThrow();
  });
});
