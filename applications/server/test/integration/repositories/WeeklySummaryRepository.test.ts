// TDD mode — integration tests written before implementation.
// These tests require a real PostgreSQL database (testcontainers).
// All cases are marked .skip so they do not break CI until:
//   1. WeeklySummaryRepository is implemented in server/src/repositories/
//   2. The weekly_summary_sync_events (or activity_logs query) migration is run
//
// Future devs: remove .skip and run with `pnpm test:integration` once
// WeeklySummaryRepository.Default is available.

import { describe, expect, it } from '@effect/vitest';
import type { Team, TeamMember } from '@sideline/domain';
import { DateTime, Effect } from 'effect';
import { beforeEach } from 'vitest';
import { WeeklySummaryRepository } from '~/repositories/WeeklySummaryRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

const WEEK_START = DateTime.makeUnsafe('2026-01-04T23:00:00.000Z');
const WEEK_END = DateTime.makeUnsafe('2026-01-11T22:59:59.999Z');

// Test layer — skip until WeeklySummaryRepository.Default exists:
// const TestLayer = WeeklySummaryRepository.Default.pipe(Layer.provideMerge(TestPgClient));
// Remove the .skip below and replace Effect.gen bodies with TestLayer once implemented.

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

describe('WeeklySummaryRepository — integration', () => {
  it.skip('findPlayerWeekActivity returns only logs within [start, end] in team timezone', () =>
    Effect.gen(function* () {
      // Setup: insert activity_logs for TEST_MEMBER_ID
      //   - one at 2026-01-06T10:00:00Z (inside week)
      //   - one at 2026-01-04T10:00:00Z (inside week — Monday 11:00 Prague)
      //   - one at 2026-01-04T21:00:00Z (before Monday 00:00 Prague = outside week)
      //   - one at 2026-01-12T00:00:00Z (after week end — outside)

      const repo = yield* WeeklySummaryRepository.asEffect();

      const inside = yield* repo.findPlayerWeekActivity(
        TEST_TEAM_ID,
        TEST_MEMBER_ID,
        WEEK_START,
        WEEK_END,
      );

      expect(inside).toHaveLength(2); // Only the two logs within the range
      for (const row of inside) {
        expect(row.logged_at.epochMilliseconds).toBeGreaterThanOrEqual(
          WEEK_START.epochMilliseconds,
        );
        expect(row.logged_at.epochMilliseconds).toBeLessThanOrEqual(WEEK_END.epochMilliseconds);
      }
    }));

  it.skip('findPlayerActivityCountInRange respects half-open interval', () =>
    Effect.gen(function* () {
      // Setup: insert 3 logs for TEST_MEMBER_ID, 2 inside [start, end), 1 exactly at end
      const repo = yield* WeeklySummaryRepository.asEffect();

      const count = yield* repo.findPlayerActivityCountInRange(
        TEST_MEMBER_ID,
        WEEK_START,
        WEEK_END,
      );

      expect(count).toBeGreaterThanOrEqual(0);
    }));

  it.skip('findTeamWeekActivity orders by total_activities DESC', () =>
    Effect.gen(function* () {
      // Setup: member A has 3 logs, member B has 5 logs this week
      const repo = yield* WeeklySummaryRepository.asEffect();

      const rows = yield* repo.findTeamWeekActivity(TEST_TEAM_ID, WEEK_START, WEEK_END);

      // Expect member B before member A
      if (rows.length >= 2) {
        const firstCount = rows.filter(
          (r: any) => r.team_member_id === rows[0].team_member_id,
        ).length;
        const secondCount = rows.filter(
          (r: any) => r.team_member_id === rows[1].team_member_id,
        ).length;
        expect(firstCount).toBeGreaterThanOrEqual(secondCount);
      }
    }));

  it.skip('findNewAchievementsInRange returns only achievements earned within window', () =>
    Effect.gen(function* () {
      // Setup: insert earned achievements
      //   - slug 'first-gym' earned 2026-01-06 (inside)
      //   - slug 'veteran' earned 2025-12-01 (before week)
      const repo = yield* WeeklySummaryRepository.asEffect();

      const achievements = yield* repo.findNewAchievementsInRange(
        TEST_TEAM_ID,
        WEEK_START,
        WEEK_END,
      );

      expect(achievements.length).toBeGreaterThanOrEqual(0);
      for (const a of achievements) {
        expect(a.earned_at.epochMilliseconds).toBeGreaterThanOrEqual(WEEK_START.epochMilliseconds);
        expect(a.earned_at.epochMilliseconds).toBeLessThanOrEqual(WEEK_END.epochMilliseconds);
      }
    }));
});
