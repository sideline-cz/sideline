// Nastavitelná docházka (plan §7.1, §10.1, B2). `formatPersonalChannelName`
// grows a fourth `bucket` argument and a reserve-then-slice truncation
// strategy. These tests pin:
//   1. bucket 'all' (or the argument omitted) is byte-identical to today's
//      3-argument output — the whole backward-compatibility story (plan §4.2).
//   2. bucket 'training' | 'tournament' | 'other' append the right suffix.
//   3. the B2 truncation-collision regression: reserve-then-slice must keep
//      three long-base channel names distinct where append-then-slice would
//      collide them into one.

import { describe, expect, it } from 'vitest';
import { formatPersonalChannelName } from '~/rest/channels/formatPersonalChannelName.js';

describe('formatPersonalChannelName — bucket: "all" is byte-identical to today (backward-compat guard)', () => {
  it('matches the 3-arg call exactly for the default template', () => {
    const legacy = formatPersonalChannelName('events-{discord_id}', 'Alice', '123');
    const withAllBucket = formatPersonalChannelName('events-{discord_id}', 'Alice', '123', 'all');
    expect(withAllBucket).toBe(legacy);
    expect(withAllBucket).toBe('events-123');
  });

  it('matches the 3-arg call exactly on the empty-template fallback path', () => {
    const legacy = formatPersonalChannelName('', 'Alice', '999');
    const withAllBucket = formatPersonalChannelName('', 'Alice', '999', 'all');
    expect(withAllBucket).toBe(legacy);
    expect(withAllBucket).toBe('events-999');
  });

  it('omitting the bucket argument entirely behaves the same as bucket: "all"', () => {
    const omitted = formatPersonalChannelName('events-{discord_id}', 'Alice', '123');
    const explicit = formatPersonalChannelName('events-{discord_id}', 'Alice', '123', 'all');
    expect(omitted).toBe(explicit);
  });

  it('a long name+discord_id combination truncates to exactly 100 chars, same as today, with bucket "all"', () => {
    const longName = 'x'.repeat(200);
    const legacy = formatPersonalChannelName(
      'events-{name}-{discord_id}',
      longName,
      '999999999999999999',
    );
    const withAllBucket = formatPersonalChannelName(
      'events-{name}-{discord_id}',
      longName,
      '999999999999999999',
      'all',
    );
    expect(withAllBucket).toBe(legacy);
    expect(withAllBucket.length).toBeLessThanOrEqual(100);
  });
});

describe('formatPersonalChannelName — split buckets append the fixed ASCII suffix', () => {
  it('bucket "training" appends "-trainings"', () => {
    const result = formatPersonalChannelName('events-{discord_id}', 'Alice', '123', 'training');
    expect(result).toBe('events-123-trainings');
  });

  it('bucket "tournament" appends "-tournaments"', () => {
    const result = formatPersonalChannelName('events-{discord_id}', 'Alice', '123', 'tournament');
    expect(result).toBe('events-123-tournaments');
  });

  it('bucket "other" appends "-others"', () => {
    const result = formatPersonalChannelName('events-{discord_id}', 'Alice', '123', 'other');
    expect(result).toBe('events-123-others');
  });
});

describe('formatPersonalChannelName — B2 truncation collision', () => {
  // `slugify` caps `{name}` at 90 chars, so a `'{name}'`-only template maxes out at 90
  // and can NEVER reach the 98/99-char collision threshold — the template needs literal
  // text as well as the placeholder. `'p'.repeat(99)` is a 99-char LITERAL base with no
  // placeholder at all, which is the simplest way to force the base to exactly 99 chars
  // regardless of what `{name}`/`{discord_id}` render to.
  const BASE_99 = 'p'.repeat(99);

  it('a 99-char base produces three PAIRWISE DIFFERENT, <=100-char channel names for training/tournament/other', () => {
    const discordId = '510000000000000099';
    const training = formatPersonalChannelName(BASE_99, 'Alice', discordId, 'training');
    const tournament = formatPersonalChannelName(BASE_99, 'Alice', discordId, 'tournament');
    const other = formatPersonalChannelName(BASE_99, 'Alice', discordId, 'other');

    // Each must respect Discord's 100-char channel name limit.
    expect(training.length).toBeLessThanOrEqual(100);
    expect(tournament.length).toBeLessThanOrEqual(100);
    expect(other.length).toBeLessThanOrEqual(100);

    // The regression: append-then-slice truncates '-trainings' and '-tournaments' to the
    // same 100-char string once the base reaches 98+ chars (they share only the '-t'
    // prefix), and ALL THREE buckets collapse together at 99+. Reserve-then-slice must
    // keep every bucket's name distinct regardless of base length.
    expect(training).not.toBe(tournament);
    expect(training).not.toBe(other);
    expect(tournament).not.toBe(other);

    // Each name must still end with its own suffix — proving the suffix was reserved,
    // not clipped off by the slice.
    expect(training.endsWith('-trainings')).toBe(true);
    expect(tournament.endsWith('-tournaments')).toBe(true);
    expect(other.endsWith('-others')).toBe(true);
  });

  it('sanity: append-then-slice on the same 99-char base WOULD collide (proves the base is a real regression trigger, not a vacuous one)', () => {
    // Manually reproduce the OLD (buggy) append-then-slice algorithm to confirm a 99-char
    // base is high enough to force a collision — i.e. this test's base is not vacuous the
    // way a 94-char base would be (plan §10.1#3: "A 94-char base does not collide").
    const appendThenSlice = (base: string, suffix: string) => (base + suffix).slice(0, 100);
    const training = appendThenSlice(BASE_99, '-trainings');
    const tournament = appendThenSlice(BASE_99, '-tournaments');
    const other = appendThenSlice(BASE_99, '-others');

    expect(training).toBe(tournament);
    expect(training).toBe(other);
  });

  it('a 94-char base does NOT collide even under append-then-slice (guards the guard: 99, not 94, is the right base)', () => {
    const base94 = 'p'.repeat(94);
    const appendThenSlice = (base: string, suffix: string) => (base + suffix).slice(0, 100);
    const training = appendThenSlice(base94, '-trainings');
    const tournament = appendThenSlice(base94, '-tournaments');
    const other = appendThenSlice(base94, '-others');

    expect(training).not.toBe(tournament);
    expect(training).not.toBe(other);
    expect(tournament).not.toBe(other);
  });

  it('a 90-char {name}-only template cannot reach the collision threshold (slugify caps {name} at 90)', () => {
    const longName = 'y'.repeat(200); // slugify will cap this at 90
    const discordId = '1';
    const training = formatPersonalChannelName('{name}', longName, discordId, 'training');
    const tournament = formatPersonalChannelName('{name}', longName, discordId, 'tournament');
    // Base tops out at 90 chars, well under the 98/99 collision threshold, so even the
    // buggy append-then-slice algorithm would not collide here.
    expect(training).not.toBe(tournament);
  });
});
