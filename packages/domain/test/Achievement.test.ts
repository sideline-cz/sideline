import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { AchievementEvaluationInput } from '~/models/Achievement.js';
import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_SLUG,
  AchievementSlug,
  builtInRuleKind,
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

const makeRulesStats = (
  overrides: Partial<AchievementEvaluationInput['rules']> = {},
): AchievementEvaluationInput['rules'] => ({
  examsCompleted: 0,
  perfectExams: 0,
  packagesMastered: 0,
  ...overrides,
});

const makeInput = (
  statsOverrides: Partial<StatsResult> = {},
  countsBySlug: ReadonlyMap<string, number> = new Map(),
  rulesOverrides: Partial<AchievementEvaluationInput['rules']> = {},
): AchievementEvaluationInput => ({
  stats: makeStats(statsOverrides),
  countsBySlug,
  rules: makeRulesStats(rulesOverrides),
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
// rules_first_exam — uses rules.examsCompleted
// ---------------------------------------------------------------------------

describe('Achievement: rules_first_exam', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('rules_first_exam')!;

  it('isEarned returns true at boundary examsCompleted=1', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { examsCompleted: 1 }), entry.defaultThreshold),
    ).toBe(true);
  });

  it('isEarned returns false at examsCompleted=0', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { examsCompleted: 0 }), entry.defaultThreshold),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rules_perfect_exam — uses rules.perfectExams
// ---------------------------------------------------------------------------

describe('Achievement: rules_perfect_exam', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('rules_perfect_exam')!;

  it('isEarned returns true at boundary perfectExams=1', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { perfectExams: 1 }), entry.defaultThreshold),
    ).toBe(true);
  });

  it('isEarned returns false at perfectExams=0', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { perfectExams: 0 }), entry.defaultThreshold),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rules_package_mastered — uses rules.packagesMastered, threshold=1
// ---------------------------------------------------------------------------

describe('Achievement: rules_package_mastered', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('rules_package_mastered')!;

  it('isEarned returns true at boundary packagesMastered=1', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { packagesMastered: 1 }), entry.defaultThreshold),
    ).toBe(true);
  });

  it('isEarned returns false at packagesMastered=0', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { packagesMastered: 0 }), entry.defaultThreshold),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rules_all_packages — uses rules.packagesMastered, threshold=9
// ---------------------------------------------------------------------------

describe('Achievement: rules_all_packages', () => {
  const entry = ACHIEVEMENTS_BY_SLUG.get('rules_all_packages')!;

  it('isEarned returns true at boundary packagesMastered=9', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { packagesMastered: 9 }), entry.defaultThreshold),
    ).toBe(true);
  });

  it('isEarned returns false at packagesMastered=8', () => {
    expect(
      entry.isEarned(makeInput({}, new Map(), { packagesMastered: 8 }), entry.defaultThreshold),
    ).toBe(false);
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
  // 11 pre-existing + 4 rules-trainer milestones (Phase 3b of
  // docs/plans/rules-trainer.md's step 15): rules_first_exam,
  // rules_perfect_exam, rules_package_mastered, rules_all_packages.
  it('has all 15 entries', () => {
    expect(ACHIEVEMENTS_BY_SLUG.size).toBe(15);
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
  // Was 5 before Phase 3b of docs/plans/rules-trainer.md's step 15 added
  // `rules_all_packages` — the plan's "knows the rules" role, deliberately
  // the ONLY rules-trainer slug that grants a role (the other three rules
  // milestones do not). That makes 6, not a reflexive bump.
  it('exactly 6 entries have grantsDiscordRole=true', () => {
    const roleGranters = ACHIEVEMENTS.filter((a) => a.grantsDiscordRole);
    expect(roleGranters).toHaveLength(6);
  });

  it('rules_all_packages grants discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('rules_all_packages')?.grantsDiscordRole).toBe(true);
  });

  it('rules_first_exam does NOT grant discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('rules_first_exam')?.grantsDiscordRole).toBe(false);
  });

  it('rules_perfect_exam does NOT grant discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('rules_perfect_exam')?.grantsDiscordRole).toBe(false);
  });

  it('rules_package_mastered does NOT grant discord role', () => {
    expect(ACHIEVEMENTS_BY_SLUG.get('rules_package_mastered')?.grantsDiscordRole).toBe(false);
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
// builtInRuleKind — rules-trainer slugs (Phase 3b of docs/plans/rules-trainer.md)
// ---------------------------------------------------------------------------

describe('builtInRuleKind — rules-trainer slugs', () => {
  it("maps rules_first_exam to 'rules_exams_completed'", () => {
    expect(builtInRuleKind('rules_first_exam')).toBe('rules_exams_completed');
  });

  it("maps rules_perfect_exam to 'rules_perfect_exams'", () => {
    expect(builtInRuleKind('rules_perfect_exam')).toBe('rules_perfect_exams');
  });

  it("maps rules_package_mastered to 'rules_packages_mastered'", () => {
    expect(builtInRuleKind('rules_package_mastered')).toBe('rules_packages_mastered');
  });

  it("maps rules_all_packages to 'rules_packages_mastered'", () => {
    expect(builtInRuleKind('rules_all_packages')).toBe('rules_packages_mastered');
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
