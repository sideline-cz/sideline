// `1794600000_monthly_recurrence.ts` — the per-frequency CHECK `chk_event_series_recurrence`
// that replaces `event_series_frequency_check` and `chk_days_of_week`. Weekly/biweekly keep the
// old rule verbatim; monthly_by_date needs `days_of_week = '{}'` + a day 1..31; monthly_by_weekday
// needs exactly one weekday + an ordinal in (1,2,3,4,-1). The whole predicate is wrapped in
// `COALESCE(..., false)` because a CHECK passes on NULL — the `'{NULL}'` case below proves it.
//
// Run after rebuilding the migrations dist (globalSetup migrates from compiled output).

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seed = Effect.gen(function* () {
  const user = yield* createUser('owner');
  const team = yield* createTeam(nextDiscordId(), user.id);
  const member = yield* createTeamMember(team.id, user.id);
  return { teamId: team.id, memberId: member.id };
});

type Shape = {
  readonly frequency: string;
  // SQL array literal, e.g. `'{1,3}'`, `'{}'`, `'{NULL}'`
  readonly daysOfWeek: string;
  readonly dayOfMonth?: number | null;
  readonly weekOfMonth?: number | null;
};

const insertSeries = (seeded: { teamId: string; memberId: string }, shape: Shape) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql`
        INSERT INTO event_series (team_id, title, start_time, frequency, days_of_week,
                                  day_of_month, week_of_month, start_date, created_by)
        VALUES (${seeded.teamId}, 'Series', '18:00'::time, ${shape.frequency},
                ${shape.daysOfWeek}::integer[], ${shape.dayOfMonth ?? null},
                ${shape.weekOfMonth ?? null}, '2027-01-01'::date, ${seeded.memberId})
      `,
    ),
  );

const accepted: ReadonlyArray<[string, Shape]> = [
  ['weekly {1,3}', { frequency: 'weekly', daysOfWeek: '{1,3}' }],
  ['biweekly {0..6}', { frequency: 'biweekly', daysOfWeek: '{0,1,2,3,4,5,6}' }],
  ['by_date {} + 31', { frequency: 'monthly_by_date', daysOfWeek: '{}', dayOfMonth: 31 }],
  ['by_weekday {2} + -1', { frequency: 'monthly_by_weekday', daysOfWeek: '{2}', weekOfMonth: -1 }],
  ['by_weekday {2} + 4', { frequency: 'monthly_by_weekday', daysOfWeek: '{2}', weekOfMonth: 4 }],
];

const rejected: ReadonlyArray<[string, Shape]> = [
  ['weekly {}', { frequency: 'weekly', daysOfWeek: '{}' }],
  ['weekly 8 days', { frequency: 'weekly', daysOfWeek: '{0,1,2,3,4,5,6,0}' }],
  ['weekly + day_of_month 5', { frequency: 'weekly', daysOfWeek: '{1}', dayOfMonth: 5 }],
  ['weekly + week_of_month 1', { frequency: 'weekly', daysOfWeek: '{1}', weekOfMonth: 1 }],
  ['by_date {1} + 15', { frequency: 'monthly_by_date', daysOfWeek: '{1}', dayOfMonth: 15 }],
  ['by_date {} + 0', { frequency: 'monthly_by_date', daysOfWeek: '{}', dayOfMonth: 0 }],
  ['by_date {} + 32', { frequency: 'monthly_by_date', daysOfWeek: '{}', dayOfMonth: 32 }],
  ['by_date {} + NULL', { frequency: 'monthly_by_date', daysOfWeek: '{}', dayOfMonth: null }],
  [
    'by_date {} + 15 + week_of_month 1',
    { frequency: 'monthly_by_date', daysOfWeek: '{}', dayOfMonth: 15, weekOfMonth: 1 },
  ],
  [
    'by_weekday {2,4} + 1',
    { frequency: 'monthly_by_weekday', daysOfWeek: '{2,4}', weekOfMonth: 1 },
  ],
  ['by_weekday {} + 1', { frequency: 'monthly_by_weekday', daysOfWeek: '{}', weekOfMonth: 1 }],
  ['by_weekday {2} + 5', { frequency: 'monthly_by_weekday', daysOfWeek: '{2}', weekOfMonth: 5 }],
  ['by_weekday {2} + 0', { frequency: 'monthly_by_weekday', daysOfWeek: '{2}', weekOfMonth: 0 }],
  [
    'by_weekday {2} + NULL',
    { frequency: 'monthly_by_weekday', daysOfWeek: '{2}', weekOfMonth: null },
  ],
  ['by_weekday {7} + 1', { frequency: 'monthly_by_weekday', daysOfWeek: '{7}', weekOfMonth: 1 }],
  [
    'by_weekday {NULL} + 1 (proves the COALESCE)',
    { frequency: 'monthly_by_weekday', daysOfWeek: '{NULL}', weekOfMonth: 1 },
  ],
  [
    'by_weekday {2} + 1 + day_of_month 3',
    { frequency: 'monthly_by_weekday', daysOfWeek: '{2}', weekOfMonth: 1, dayOfMonth: 3 },
  ],
  ["frequency 'daily'", { frequency: 'daily', daysOfWeek: '{1}' }],
];

describe('event_series chk_event_series_recurrence', () => {
  for (const [name, shape] of accepted) {
    it.effect(`accepts ${name}`, () =>
      Effect.gen(function* () {
        const seeded = yield* seed;
        yield* insertSeries(seeded, shape);
      }).pipe(Effect.provide(TestLayer)),
    );
  }

  for (const [name, shape] of rejected) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const seeded = yield* seed;
        const error = yield* Effect.flip(insertSeries(seeded, shape));
        // Rejected by THIS constraint — not by a missing column or the old frequency CHECK.
        const cause = (error as { cause?: { message?: string; constraint?: string } }).cause;
        expect(`${error.message} ${cause?.message ?? ''} ${cause?.constraint ?? ''}`).toContain(
          'chk_event_series_recurrence',
        );
      }).pipe(Effect.provide(TestLayer)),
    );
  }

  it.effect('drops event_series_frequency_check and chk_days_of_week', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ conname: string }>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'event_series'::regclass AND contype = 'c'
      `;
      const names = rows.map((r) => r.conname);
      expect(names).toContain('chk_event_series_recurrence');
      expect(names).not.toContain('event_series_frequency_check');
      expect(names).not.toContain('chk_days_of_week');
    }).pipe(Effect.provide(TestLayer)),
  );
});
