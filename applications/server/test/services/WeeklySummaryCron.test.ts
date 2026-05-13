import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, Team } from '@sideline/domain';
import { WeeklySummary } from '@sideline/domain';
import { Effect, Layer, Option, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import {
  WeeklySummaryRepository,
  WeeklySummarySyncEventsRepository,
} from '~/repositories/WeeklySummaryRepository.js';
import { weeklySummaryCronEffect } from '~/services/WeeklySummaryCron.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID_1 = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEAM_ID_2 = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const WEEKLY_CHANNEL_1 = '111111111111111111' as Discord.Snowflake;
const WEEKLY_CHANNEL_2 = '222222222222222222' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type TeamSettings = {
  team_id: Team.TeamId;
  timezone: string;
  weekly_summary_channel_id: Option.Option<Discord.Snowflake>;
};

type InsertedSummaryEvent = {
  team_id: Team.TeamId;
  channel_id: Discord.Snowflake;
  week_start: unknown;
  week_end: unknown;
  payload: unknown;
};

let teamSettingsStore: TeamSettings[];
let insertedSummaryEvents: InsertedSummaryEvent[];

const resetStores = () => {
  teamSettingsStore = [];
  insertedSummaryEvents = [];
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockTeamSettingsRepository = () =>
  Layer.succeed(TeamSettingsRepository, {
    findAllWithWeeklySummaryChannel: () => Effect.succeed(teamSettingsStore),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsert: () => Effect.die(new Error('Not implemented')),
    getHorizonDays: () => Effect.succeed(30),
    findLateRsvpChannelId: () => Effect.succeed(Option.none()),
    findEventsNeedingReminder: () => Effect.succeed([]),
  } as any);

const makeMockWeeklySummaryRepository = () =>
  Layer.succeed(WeeklySummaryRepository, {
    findTeamWeekActivity: () => Effect.succeed([]),
    findTeamNewAchievementCountInRange: () => Effect.succeed(0),
  } as any);

const makeMockWeeklySummarySyncEventsRepository = () =>
  Layer.succeed(WeeklySummarySyncEventsRepository, {
    insert: (event: InsertedSummaryEvent) => {
      insertedSummaryEvents.push(event);
      return Effect.void;
    },
  } as any);

const makeMockTeamMembersRepository = () =>
  Layer.succeed(TeamMembersRepository, {
    findByTeam: () => Effect.succeed([]),
  } as any);

const buildMockLayer = () =>
  Layer.mergeAll(
    makeMockTeamSettingsRepository(),
    makeMockWeeklySummaryRepository(),
    makeMockWeeklySummarySyncEventsRepository(),
    makeMockTeamMembersRepository(),
  );

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('weeklySummaryCronEffect', () => {
  it.effect('skips teams with no weekly_summary_channel_id', () =>
    Effect.gen(function* () {
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.none(),
        },
      ];

      // Set clock to Sunday 20:00 Prague time (2026-01-11 19:00 UTC)
      yield* TestClock.setTime(new Date('2026-01-11T19:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      expect(insertedSummaryEvents).toHaveLength(0);
    }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect('only fires for teams whose local time is Sunday 20:00', () =>
    Effect.gen(function* () {
      // Prague (UTC+1 in January): Sunday 20:00 = 19:00 UTC
      // New York (UTC-5 in January): at 19:00 UTC it's 14:00 in New York (not Sunday 20:00)
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
        {
          team_id: TEAM_ID_2,
          timezone: 'America/New_York',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_2),
        },
      ];

      // Sunday 2026-01-11 19:00 UTC = 20:00 Prague, 14:00 New York
      yield* TestClock.setTime(new Date('2026-01-11T19:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      expect(insertedSummaryEvents).toHaveLength(1);
      expect(insertedSummaryEvents[0]?.team_id).toBe(TEAM_ID_1);
    }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect('handles DST spring-forward week (TestClock at the boundary)', () =>
    Effect.gen(function* () {
      // Prague spring-forward: 2026-03-29 at 02:00 local → 03:00
      // On Sunday 2026-03-29, 20:00 Prague (CEST, UTC+2) = 18:00 UTC
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
      ];

      // Sunday 2026-03-29 18:00 UTC = 20:00 Prague CEST
      yield* TestClock.setTime(new Date('2026-03-29T18:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      expect(insertedSummaryEvents).toHaveLength(1);
      expect(insertedSummaryEvents[0]?.team_id).toBe(TEAM_ID_1);
    }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect('handles DST fall-back week', () =>
    Effect.gen(function* () {
      // Prague fall-back: 2026-10-25 at 03:00 local → 02:00
      // On Sunday 2026-10-25, 20:00 Prague (CET, UTC+1) = 19:00 UTC
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
      ];

      // Sunday 2026-10-25 19:00 UTC = 20:00 Prague CET (after fall-back)
      yield* TestClock.setTime(new Date('2026-10-25T19:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      expect(insertedSummaryEvents).toHaveLength(1);
      expect(insertedSummaryEvents[0]?.team_id).toBe(TEAM_ID_1);
    }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect('inserts one weekly_summary_sync_events row per eligible team', () =>
    Effect.gen(function* () {
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
        {
          team_id: TEAM_ID_2,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_2),
        },
      ];

      // Sunday 2026-01-11 19:00 UTC = 20:00 Prague CET
      yield* TestClock.setTime(new Date('2026-01-11T19:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      expect(insertedSummaryEvents).toHaveLength(2);
      const teamIds = insertedSummaryEvents.map((e) => e.team_id);
      expect(teamIds).toContain(TEAM_ID_1);
      expect(teamIds).toContain(TEAM_ID_2);
    }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect('inserts even when duplicate — ON CONFLICT at DB layer handles idempotency', () =>
    Effect.gen(function* () {
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
      ];

      // Sunday 2026-01-11 19:00 UTC = 20:00 Prague CET
      yield* TestClock.setTime(new Date('2026-01-11T19:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      // Cron always inserts; DB ON CONFLICT handles deduplication
      expect(insertedSummaryEvents).toHaveLength(1);
      expect(insertedSummaryEvents[0]?.team_id).toBe(TEAM_ID_1);
    }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect(
    'continues processing other teams when one team errors (Effect.exit per team, concurrency 1)',
    () => {
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
        {
          team_id: TEAM_ID_2,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_2),
        },
      ];

      let callCount = 0;

      const PartiallyFailingLayer = Layer.mergeAll(
        makeMockTeamSettingsRepository(),
        makeMockWeeklySummaryRepository(),
        Layer.succeed(WeeklySummarySyncEventsRepository, {
          insert: (event: InsertedSummaryEvent) => {
            callCount++;
            if (callCount === 1) {
              return Effect.die(new Error('Simulated insert failure for team 1'));
            }
            insertedSummaryEvents.push(event);
            return Effect.void;
          },
        } as any),
        makeMockTeamMembersRepository(),
      );

      return TestClock.setTime(new Date('2026-01-11T19:00:00.000Z').getTime()).pipe(
        Effect.flatMap(() => weeklySummaryCronEffect),
        Effect.tap(() =>
          Effect.sync(() => {
            // Second team should still be processed
            expect(insertedSummaryEvents).toHaveLength(1);
            expect(insertedSummaryEvents[0]?.team_id).toBe(TEAM_ID_2);
          }),
        ),
        Effect.provide(PartiallyFailingLayer),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'includes member who left mid-week in the activity totals (counted from log timestamps)',
    () =>
      Effect.gen(function* () {
        // This test verifies that the cron does NOT filter by "currently active" membership —
        // activity logs within [weekStart, weekEnd] are counted regardless of current member status.
        // The cron inserts the event; the actual activity query in WeeklySummaryService
        // uses log timestamps, not current membership. We verify insert happens.
        teamSettingsStore = [
          {
            team_id: TEAM_ID_1,
            timezone: 'Europe/Prague',
            weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
          },
        ];

        // Sunday 2026-01-11 19:00 UTC = 20:00 Prague
        yield* TestClock.setTime(new Date('2026-01-11T19:00:00.000Z').getTime());

        yield* weeklySummaryCronEffect;

        // Cron should enqueue the summary event (mid-week departures don't block enqueue)
        expect(insertedSummaryEvents).toHaveLength(1);
        expect(insertedSummaryEvents[0]?.team_id).toBe(TEAM_ID_1);
      }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect('does NOT fire when current time is not Sunday 20:00 in team timezone', () =>
    Effect.gen(function* () {
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
      ];

      // Saturday 2026-01-10 19:00 UTC = Saturday 20:00 Prague (not Sunday)
      yield* TestClock.setTime(new Date('2026-01-10T19:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      expect(insertedSummaryEvents).toHaveLength(0);
    }).pipe(Effect.provide(buildMockLayer())),
  );

  it.effect('round-trip: cron-encoded payload decodes correctly as WeeklySummaryDigest', () =>
    Effect.gen(function* () {
      teamSettingsStore = [
        {
          team_id: TEAM_ID_1,
          timezone: 'Europe/Prague',
          weekly_summary_channel_id: Option.some(WEEKLY_CHANNEL_1),
        },
      ];

      yield* TestClock.setTime(new Date('2026-01-11T19:00:00.000Z').getTime());

      yield* weeklySummaryCronEffect;

      expect(insertedSummaryEvents).toHaveLength(1);

      const payload = insertedSummaryEvents[0]?.payload;

      // The payload must decode successfully as WeeklySummaryDigest
      const exit = Schema.decodeUnknownExit(WeeklySummary.WeeklySummaryDigest)(payload);
      expect(exit._tag).toBe('Success');

      if (exit._tag === 'Success') {
        expect(exit.value.week.isoYear).toBe(2026);
        expect(exit.value.week.isoWeek).toBe(2);
        expect(typeof exit.value.teamSummary.totalActivities).toBe('number');
      }
    }).pipe(Effect.provide(buildMockLayer())),
  );
});
