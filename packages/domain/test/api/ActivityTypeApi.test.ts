import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as ActivityTypeApi from '~/api/ActivityTypeApi.js';

// ---------------------------------------------------------------------------
// CreateActivityTypeRequest
// ---------------------------------------------------------------------------

describe('CreateActivityTypeRequest', () => {
  it('decodes minimal input { name: "Yoga", emoji: null, description: null } with emoji/description as Option.none', () => {
    // OptionFromNullOr requires the keys to be present as null (not absent).
    // The "minimal" payload still provides the optional fields as null.
    const result = Schema.decodeUnknownSync(ActivityTypeApi.CreateActivityTypeRequest)({
      name: 'Yoga',
      emoji: null,
      description: null,
    });
    expect(result.name).toBe('Yoga');
    expect(Option.isNone(result.emoji)).toBe(true);
    expect(Option.isNone(result.description)).toBe(true);
  });

  it('decodes full input with name, emoji, and description', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.CreateActivityTypeRequest)({
      name: 'Yoga',
      emoji: '🧘',
      description: 'Daily stretch',
    });
    expect(result.name).toBe('Yoga');
    expect(Option.getOrNull(result.emoji)).toBe('🧘');
    expect(Option.getOrNull(result.description)).toBe('Daily stretch');
  });

  it('decodes input with null emoji and null description as Option.none', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.CreateActivityTypeRequest)({
      name: 'Yoga',
      emoji: null,
      description: null,
    });
    expect(result.name).toBe('Yoga');
    expect(Option.isNone(result.emoji)).toBe(true);
    expect(Option.isNone(result.description)).toBe(true);
  });

  it('rejects empty name', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityTypeApi.CreateActivityTypeRequest)({
        name: '',
        emoji: null,
        description: null,
      }),
    ).toThrow();
  });

  it('rejects name longer than 50 characters', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityTypeApi.CreateActivityTypeRequest)({
        name: 'A'.repeat(51),
        emoji: null,
        description: null,
      }),
    ).toThrow();
  });

  it('accepts name of exactly 50 characters (boundary)', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.CreateActivityTypeRequest)({
      name: 'A'.repeat(50),
      emoji: null,
      description: null,
    });
    expect(result.name).toHaveLength(50);
  });

  it('rejects missing name field', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityTypeApi.CreateActivityTypeRequest)({
        emoji: null,
        description: null,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// UpdateActivityTypeRequest
// ---------------------------------------------------------------------------

describe('UpdateActivityTypeRequest', () => {
  it('decodes empty object {} — all fields are Option.none (absent)', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({});
    expect(Option.isNone(result.name)).toBe(true);
    expect(Option.isNone(result.emoji)).toBe(true);
    expect(Option.isNone(result.description)).toBe(true);
  });

  it('decodes { emoji: null } as Option.some(Option.none) (explicit clear)', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({
      emoji: null,
    });
    // emoji field is present (Option.some) but set to null (inner Option.none)
    expect(Option.isSome(result.emoji)).toBe(true);
    if (Option.isSome(result.emoji)) {
      expect(Option.isNone(result.emoji.value)).toBe(true);
    }
  });

  it('decodes { emoji: "🧘" } as Option.some(Option.some("🧘"))', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({
      emoji: '🧘',
    });
    expect(Option.isSome(result.emoji)).toBe(true);
    if (Option.isSome(result.emoji)) {
      expect(Option.isSome(result.emoji.value)).toBe(true);
      if (Option.isSome(result.emoji.value)) {
        expect(result.emoji.value.value).toBe('🧘');
      }
    }
  });

  it('decodes { name: "New Name" } as Option.some("New Name") for name', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({
      name: 'New Name',
    });
    expect(Option.isSome(result.name)).toBe(true);
    if (Option.isSome(result.name)) {
      expect(result.name.value).toBe('New Name');
    }
  });

  it('decodes { description: null } as explicit clear of description', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({
      description: null,
    });
    expect(Option.isSome(result.description)).toBe(true);
    if (Option.isSome(result.description)) {
      expect(Option.isNone(result.description.value)).toBe(true);
    }
  });

  it('rejects name longer than 50 characters', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({
        name: 'A'.repeat(51),
      }),
    ).toThrow();
  });

  it('rejects empty name (NonEmptyString constraint)', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({
        name: '',
      }),
    ).toThrow();
  });

  it('rejects description longer than 200 characters', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityTypeApi.UpdateActivityTypeRequest)({
        description: 'A'.repeat(201),
      }),
    ).toThrow();
  });
});
