import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
  ActivityTypeDescription,
  ActivityTypeEmoji,
  ActivityTypeName,
} from '~/models/ActivityType.js';

// ---------------------------------------------------------------------------
// ActivityTypeName
// ---------------------------------------------------------------------------

describe('ActivityTypeName schema', () => {
  it('accepts a single character name', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeName)('A');
    expect(result).toBe('A');
  });

  it('accepts a 50-character name (boundary)', () => {
    const name = 'A'.repeat(50);
    const result = Schema.decodeUnknownSync(ActivityTypeName)(name);
    expect(result).toBe(name);
  });

  it('accepts a typical name "Yoga"', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeName)('Yoga');
    expect(result).toBe('Yoga');
  });

  it('rejects empty string', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeName)('')).toThrow();
  });

  it('rejects a 51-character name (above max length)', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeName)('A'.repeat(51))).toThrow();
  });

  it('rejects null', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeName)(null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ActivityTypeDescription
// ---------------------------------------------------------------------------

describe('ActivityTypeDescription schema', () => {
  it('accepts empty string (0 chars)', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeDescription)('');
    expect(result).toBe('');
  });

  it('accepts a typical description', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeDescription)('Daily stretch routine');
    expect(result).toBe('Daily stretch routine');
  });

  it('accepts a 200-character description (boundary)', () => {
    const desc = 'A'.repeat(200);
    const result = Schema.decodeUnknownSync(ActivityTypeDescription)(desc);
    expect(result).toBe(desc);
  });

  it('rejects a 201-character description (above max length)', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeDescription)('A'.repeat(201))).toThrow();
  });

  it('rejects null', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeDescription)(null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ActivityTypeEmoji
// ---------------------------------------------------------------------------

describe('ActivityTypeEmoji schema', () => {
  it('accepts single emoji 🧘', () => {
    const result = Schema.decodeUnknownSync(ActivityTypeEmoji)('🧘');
    expect(result).toBe('🧘');
  });

  it('accepts ZWJ-joined family emoji 👨‍👩‍👧 (multi-codepoint single grapheme)', () => {
    // 👨‍👩‍👧 is a ZWJ sequence: multiple codepoints but a single grapheme cluster
    const zwjEmoji = '👨‍👩‍👧';
    const result = Schema.decodeUnknownSync(ActivityTypeEmoji)(zwjEmoji);
    expect(result).toBe(zwjEmoji);
  });

  it('accepts a simple ASCII emoji substitute for runtime compatibility', () => {
    // Single character emoji-like value
    const result = Schema.decodeUnknownSync(ActivityTypeEmoji)('🏋');
    expect(result).toBe('🏋');
  });

  it('rejects empty string', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeEmoji)('')).toThrow();
  });

  it('rejects plain text "ab" (two graphemes, not a single emoji)', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeEmoji)('ab')).toThrow();
  });

  it('rejects two separate emojis "🧘🧘" (two graphemes)', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeEmoji)('🧘🧘')).toThrow();
  });

  it('rejects null', () => {
    expect(() => Schema.decodeUnknownSync(ActivityTypeEmoji)(null)).toThrow();
  });
});
