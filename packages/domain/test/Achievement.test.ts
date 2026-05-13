import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { AchievementEvaluationInput } from '~/models/Achievement.js';
import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_SLUG,
  AchievementSlug,
  i18nDescriptionKey,
  i18nTitleKey,
} from '~/models/Achievement.js';
import type { StatsResult } from '~/models/ActivityStats.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeStats = (overrides: Partial<StatsResult> = {}): StatsResult => ({
  currentStreak: 0,
  longestStreak: 0,
  totalActivities: 0,
  totalDurationMinutes: 0,
  counts: [],
  ...overrides,
});

const makeInput = (
  statsOverrides: Partial<StatsResult> = {},
  countsBySlug: ReadonlyMap<string, number> = new Map(),
): AchievementEvaluationInput => ({
  stats: makeStats(statsOverrides),
  countsBySlug,
});

// ---------------------------------------------------------------------------
// first_activity
// ---------------------------------------------------------------------------

describe('Achievement: first_activity', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('first_activity')!;

  it('isEarned returns true when totalActivities=1', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 1 }), entry.defaultThreshold)).toBe(true);
  });

  it('isEarned returns false when totalActivities=0', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 0 }), entry.defaultThreshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ten_activities
// ---------------------------------------------------------------------------

describe('Achievement: ten_activities', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('ten_activities')!;

  it('isEarned returns true at boundary totalActivities=10', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 10 }), entry.defaultThreshold)).toBe(true);
  });

  it('isEarned returns false at totalActivities=9', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 9 }), entry.defaultThreshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fifty_activities
// ---------------------------------------------------------------------------

describe('Achievement: fifty_activities', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('fifty_activities')!;

  it('isEarned returns true at boundary totalActivities=50', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 50 }), entry.defaultThreshold)).toBe(true);
  });

  it('isEarned returns false at totalActivities=49', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 49 }), entry.defaultThreshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hundred_activities
// ---------------------------------------------------------------------------

describe('Achievement: hundred_activities', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('hundred_activities')!;

  it('isEarned returns true at boundary totalActivities=100', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 100 }), entry.defaultThreshold)).toBe(true);
  });

  it('isEarned returns false at totalActivities=99', () => {
    expect(entry.isEarned(makeInput({ totalActivities: 99 }), entry.defaultThreshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streak_3 — uses longestStreak
// ---------------------------------------------------------------------------

describe('Achievement: streak_3', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('streak_3')!;

  it('isEarned returns true when longestStreak=3 and currentStreak=0 (broken streak still counts)', () => {
    expect(
      entry.isEarned(makeInput({ longestStreak: 3, currentStreak: 0 }), entry.defaultThreshold),
    ).toBe(true);
  });

  it('isEarned returns false when longestStreak=2', () => {
    expect(entry.isEarned(makeInput({ longestStreak: 2 }), entry.defaultThreshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streak_7
// ---------------------------------------------------------------------------

describe('Achievement: streak_7', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('streak_7')!;

  it('isEarned returns true at boundary longestStreak=7', () => {
    expect(entry.isEarned(makeInput({ longestStreak: 7 }), entry.defaultThreshold)).toBe(true);
  });

  it('isEarned returns false at longestStreak=6', () => {
    expect(entry.isEarned(makeInput({ longestStreak: 6 }), entry.defaultThreshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streak_30
// ---------------------------------------------------------------------------

describe('Achievement: streak_30', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('streak_30')!;

  it('isEarned returns true at boundary longestStreak=30', () => {
    expect(entry.isEarned(makeInput({ longestStreak: 30 }), entry.defaultThreshold)).toBe(true);
  });

  it('isEarned returns false at longestStreak=29', () => {
    expect(entry.isEarned(makeInput({ longestStreak: 29 }), entry.defaultThreshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// duration_600
// ---------------------------------------------------------------------------

describe('Achievement: duration_600', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('duration_600')!;

  it('isEarned returns true at boundary totalDurationMinutes=600', () => {
    expect(entry.isEarned(makeInput({ totalDurationMinutes: 600 }), entry.defaultThreshold)).toBe(
      true,
    );
  });

  it('isEarned returns false at totalDurationMinutes=599', () => {
    expect(entry.isEarned(makeInput({ totalDurationMinutes: 599 }), entry.defaultThreshold)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// duration_3000
// ---------------------------------------------------------------------------

describe('Achievement: duration_3000', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('duration_3000')!;

  it('isEarned returns true at boundary totalDurationMinutes=3000', () => {
    expect(entry.isEarned(makeInput({ totalDurationMinutes: 3000 }), entry.defaultThreshold)).toBe(
      true,
    );
  });

  it('isEarned returns false at totalDurationMinutes=2999', () => {
    expect(entry.isEarned(makeInput({ totalDurationMinutes: 2999 }), entry.defaultThreshold)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// gym_25 — uses countsBySlug
// ---------------------------------------------------------------------------

describe('Achievement: gym_25', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('gym_25')!;

  it('isEarned returns true when countsBySlug has gym=25', () => {
    expect(entry.isEarned(makeInput({}, new Map([['gym', 25]])), entry.defaultThreshold)).toBe(
      true,
    );
  });

  it('isEarned returns false when countsBySlug has gym=24', () => {
    expect(entry.isEarned(makeInput({}, new Map([['gym', 24]])), entry.defaultThreshold)).toBe(
      false,
    );
  });

  it('isEarned returns false when only running=100 (no gym entry)', () => {
    expect(entry.isEarned(makeInput({}, new Map([['running', 100]])), entry.defaultThreshold)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// running_25 — uses countsBySlug
// ---------------------------------------------------------------------------

describe('Achievement: running_25', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('running_25')!;

  it('isEarned returns true when countsBySlug has running=25', () => {
    expect(entry.isEarned(makeInput({}, new Map([['running', 25]])), entry.defaultThreshold)).toBe(
      true,
    );
  });

  it('isEarned returns false when countsBySlug has running=24', () => {
    expect(entry.isEarned(makeInput({}, new Map([['running', 24]])), entry.defaultThreshold)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// i18n key helpers
// ---------------------------------------------------------------------------

describe('i18nTitleKey', () => {
  it("returns 'achievement_streak_7_title' for slug 'streak_7'", () => {
    expect(i18nTitleKey('streak_7')).toBe('achievement_streak_7_title');
  });
});

describe('i18nDescriptionKey', () => {
  it("returns 'achievement_gym_25_description' for slug 'gym_25'", () => {
    expect(i18nDescriptionKey('gym_25')).toBe('achievement_gym_25_description');
  });
});

// ---------------------------------------------------------------------------
// ACHIEVEMENTS_BY_SLUG catalog
// ---------------------------------------------------------------------------

describe('ACHIEVEMENTS_BY_SLUG', () => {
  it('has all 11 entries', () => {
    expect(ACHIEVEMENTS_BY_SLUG.size).toBe(11);
  });

  it('contains every slug from ACHIEVEMENTS array', () => {
    for (const entry of ACHIEVEMENTS) {
      expect(ACHIEVEMENTS_BY_SLUG.has(entry.slug)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// grantsDiscordRole — exactly 5 entries
// ---------------------------------------------------------------------------

describe('grantsDiscordRole', () => {
  it('exactly 5 entries have grantsDiscordRole=true', () => {
    const roleGranters = ACHIEVEMENTS.filter((a) => a.grantsDiscordRole);
    expect(roleGranters).toHaveLength(5);
  });

  it('fifty_activities grants discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('fifty_activities')?.grantsDiscordRole).toBe(true);
  });

  it('hundred_activities grants discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('hundred_activities')?.grantsDiscordRole).toBe(true);
  });

  it('streak_7 grants discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('streak_7')?.grantsDiscordRole).toBe(true);
  });

  it('streak_30 grants discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('streak_30')?.grantsDiscordRole).toBe(true);
  });

  it('duration_3000 grants discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('duration_3000')?.grantsDiscordRole).toBe(true);
  });

  it('first_activity does NOT grant discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('first_activity')?.grantsDiscordRole).toBe(false);
  });

  it('ten_activities does NOT grant discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('ten_activities')?.grantsDiscordRole).toBe(false);
  });

  it('gym_25 does NOT grant discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('gym_25')?.grantsDiscordRole).toBe(false);
  });

  it('running_25 does NOT grant discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('running_25')?.grantsDiscordRole).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AchievementSlug — closed literal (regression for catalog-refactor)
// ---------------------------------------------------------------------------

describe('AchievementSlug', () => {
  it.effect(
    'rejects unknown slugs (closed literal preserved after threshold-parameter refactor)',
    () =>
      Schema.decodeUnknownEffect(AchievementSlug)('made_up_slug').pipe(
        Effect.flip,
        Effect.tap((err) =>
          Effect.sync(() => {
            // SchemaError means decoding failed — the slug is not in the literal union
            expect(err._tag).toBe('SchemaError');
          }),
        ),
      ),
  );
});
