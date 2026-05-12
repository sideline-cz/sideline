// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They reference AchievementEvaluator, EarnedAchievementsRepository, and
// AchievementSyncEventsRepository which do NOT exist yet.
// Tests will FAIL until the developer implements those server-side services.

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Achievement, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { AchievementSyncEventsRepository } from '~/repositories/AchievementSyncEventsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
// These imports will fail until implementations exist:
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMBER_ID = '00000000-0000-0000-0000-000000000010' as TeamMember.TeamMemberId;
const TEAM_ID = '00000000-0000-0000-0000-000000000001' as any;

// ---------------------------------------------------------------------------
// In-memory stores (reset between tests)
// ---------------------------------------------------------------------------

type InsertIfMissingCall = {
  teamMemberId: TeamMember.TeamMemberId;
  slug: Achievement.AchievementSlug;
};
type SyncEventEmitCall = {
  teamId: string;
  teamMemberId: TeamMember.TeamMemberId;
  slug: Achievement.AchievementSlug;
};

let insertIfMissingCalls: InsertIfMissingCall[];
let syncEventEmitCalls: SyncEventEmitCall[];
let alreadyEarned: Set<Achievement.AchievementSlug>;
let activityCountsBySlug: Array<{ slug: string; count: number }>;
let insertIfMissingReturnValue: boolean;

// Stats defaults
let mockTotalActivities: number;
let mockTotalDurationMinutes: number;

const resetStores = () => {
  insertIfMissingCalls = [];
  syncEventEmitCalls = [];
  alreadyEarned = new Set();
  activityCountsBySlug = [];
  insertIfMissingReturnValue = true;
  mockTotalActivities = 0;
  mockTotalDurationMinutes = 0;
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeActivityLogsRepositoryLayer = () =>
  Layer.succeed(ActivityLogsRepository, {
    findByTeamMember: () =>
      Effect.succeed(
        Array.from({ length: mockTotalActivities }, (_, i) => ({
          activity_type_id: 'type-gym' as any,
          activity_type_name: 'Gym',
          logged_at_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
          duration_minutes: Option.some(
            Math.floor(mockTotalDurationMinutes / Math.max(mockTotalActivities, 1)),
          ),
        })),
      ),
    findByMember: () => Effect.succeed([]),
    findById: () => Effect.succeed(Option.none()),
    insert: () => Effect.die(new Error('Not implemented')),
    update: () => Effect.die(new Error('Not implemented')),
    delete: () => Effect.die(new Error('Not implemented')),
  } as any);

const makeEarnedAchievementsRepositoryLayer = () =>
  Layer.succeed(EarnedAchievementsRepository, {
    insertIfMissing: (teamMemberId: TeamMember.TeamMemberId, slug: Achievement.AchievementSlug) => {
      insertIfMissingCalls.push({ teamMemberId, slug });
      return Effect.succeed(insertIfMissingReturnValue);
    },
    findEarnedSlugs: (_teamMemberId: TeamMember.TeamMemberId) =>
      Effect.succeed(new Set(alreadyEarned)),
    findByMember: () => Effect.succeed([]),
    getActivityCountsBySlug: (_teamMemberId: TeamMember.TeamMemberId) =>
      Effect.succeed(activityCountsBySlug),
  } as any);

const makeAchievementSyncEventsRepositoryLayer = () =>
  Layer.succeed(AchievementSyncEventsRepository, {
    emit: (
      teamId: string,
      teamMemberId: TeamMember.TeamMemberId,
      slug: Achievement.AchievementSlug,
    ) => {
      syncEventEmitCalls.push({ teamId, teamMemberId, slug });
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const makeTeamMembersRepositoryLayer = () =>
  Layer.succeed(TeamMembersRepository, {
    findById: (_id: TeamMember.TeamMemberId) =>
      Effect.succeed(
        Option.some({
          id: MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-001' as any,
          active: true,
        }),
      ),
    addMember: () => Effect.die(new Error('Not implemented')),
    findByTeamId: () => Effect.succeed([]),
    findRosterEntry: () => Effect.succeed(Option.none()),
    findMemberByUserId: () => Effect.succeed(Option.none()),
  } as any);

const makeTestLayer = () =>
  Layer.mergeAll(
    makeActivityLogsRepositoryLayer(),
    makeEarnedAchievementsRepositoryLayer(),
    makeAchievementSyncEventsRepositoryLayer(),
    makeTeamMembersRepositoryLayer(),
    AchievementEvaluator.Default,
  );

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AchievementEvaluator.evaluate', () => {
  it.effect('emits no sync events when no thresholds crossed (totalActivities=0)', () =>
    AchievementEvaluator.asEffect().pipe(
      Effect.andThen((svc) => svc.evaluate(MEMBER_ID)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(insertIfMissingCalls).toHaveLength(0);
          expect(syncEventEmitCalls).toHaveLength(0);
        }),
      ),
      Effect.provide(makeTestLayer()),
    ),
  );

  it.effect('inserts and emits for newly crossed threshold (totalActivities=1)', () => {
    mockTotalActivities = 1;
    return AchievementEvaluator.asEffect().pipe(
      Effect.andThen((svc) => svc.evaluate(MEMBER_ID)),
      Effect.tap(() =>
        Effect.sync(() => {
          const insertedSlugs = insertIfMissingCalls.map((c) => c.slug);
          expect(insertedSlugs).toContain('first_activity');
          expect(insertedSlugs).toHaveLength(1);

          const emittedSlugs = syncEventEmitCalls.map((c) => c.slug);
          expect(emittedSlugs).toContain('first_activity');
          expect(emittedSlugs).toHaveLength(1);
        }),
      ),
      Effect.provide(makeTestLayer()),
    );
  });

  it.effect(
    'skips already-earned slugs — pre-populate alreadyEarned={first_activity}, totalActivities=10',
    () => {
      alreadyEarned = new Set(['first_activity'] as Achievement.AchievementSlug[]);
      mockTotalActivities = 10;
      return AchievementEvaluator.asEffect().pipe(
        Effect.andThen((svc) => svc.evaluate(MEMBER_ID)),
        Effect.tap(() =>
          Effect.sync(() => {
            const insertedSlugs = insertIfMissingCalls.map((c) => c.slug);
            // ten_activities should be inserted
            expect(insertedSlugs).toContain('ten_activities');
            // first_activity must NOT be retouched
            expect(insertedSlugs).not.toContain('first_activity');

            const emittedSlugs = syncEventEmitCalls.map((c) => c.slug);
            expect(emittedSlugs).toContain('ten_activities');
            expect(emittedSlugs).not.toContain('first_activity');
          }),
        ),
        Effect.provide(makeTestLayer()),
      );
    },
  );

  it.effect(
    'handles ON CONFLICT idempotency — insertIfMissing returns false → syncEvents.emit NOT called',
    () => {
      mockTotalActivities = 1;
      insertIfMissingReturnValue = false;
      return AchievementEvaluator.asEffect().pipe(
        Effect.andThen((svc) => svc.evaluate(MEMBER_ID)),
        Effect.tap(() =>
          Effect.sync(() => {
            // insertIfMissing was called
            expect(insertIfMissingCalls).toHaveLength(1);
            // but emit must NOT have been called since insertIfMissing returned false
            expect(syncEventEmitCalls).toHaveLength(0);
          }),
        ),
        Effect.provide(makeTestLayer()),
      );
    },
  );

  it.effect(
    'uses longestStreak not currentStreak — stats {currentStreak:0, longestStreak:7} → both streak_3 and streak_7 emitted',
    () => {
      // Need to override the activity logs to simulate streak data via stats
      const streakLayer = Layer.succeed(ActivityLogsRepository, {
        findByTeamMember: () =>
          Effect.succeed(
            // 7 activities spread over 7 consecutive days in the past
            Array.from({ length: 7 }, (_, i) => ({
              activity_type_id: 'type-gym' as any,
              activity_type_name: 'Gym',
              // All dates in the past so currentStreak = 0, but longestStreak = 7
              logged_at_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
              duration_minutes: Option.none() as Option.Option<number>,
            })),
          ),
        findByMember: () => Effect.succeed([]),
        findById: () => Effect.succeed(Option.none()),
        insert: () => Effect.die(new Error('Not implemented')),
        update: () => Effect.die(new Error('Not implemented')),
        delete: () => Effect.die(new Error('Not implemented')),
      } as any);

      const layer = Layer.mergeAll(
        streakLayer,
        makeEarnedAchievementsRepositoryLayer(),
        makeAchievementSyncEventsRepositoryLayer(),
        makeTeamMembersRepositoryLayer(),
        AchievementEvaluator.Default,
      );

      return AchievementEvaluator.asEffect().pipe(
        Effect.andThen((svc) => svc.evaluate(MEMBER_ID)),
        Effect.tap(() =>
          Effect.sync(() => {
            const emittedSlugs = syncEventEmitCalls.map((c) => c.slug);
            expect(emittedSlugs).toContain('streak_3');
            expect(emittedSlugs).toContain('streak_7');
          }),
        ),
        Effect.provide(layer),
      );
    },
  );

  it.effect('uses countsBySlug from dedicated query — gym_25 emitted, running_25 not', () => {
    activityCountsBySlug = [{ slug: 'gym', count: 25 }];
    return AchievementEvaluator.asEffect().pipe(
      Effect.andThen((svc) => svc.evaluate(MEMBER_ID)),
      Effect.tap(() =>
        Effect.sync(() => {
          const emittedSlugs = syncEventEmitCalls.map((c) => c.slug);
          expect(emittedSlugs).toContain('gym_25');
          expect(emittedSlugs).not.toContain('running_25');
        }),
      ),
      Effect.provide(makeTestLayer()),
    );
  });
});
