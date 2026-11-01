// `1794700000_event_series_event_type.ts` — event_series gains event_type + event_type_id and
// REUSES events_sync_event_type() through event_series_sync_event_type_trg. These tests pin that
// a series resolves/authorizes a type exactly as a one-time event does (compared against what
// the events trigger picks in the same team, never a hand-picked id).
//
// Run after rebuilding the migrations dist (globalSetup migrates from compiled output).

import { describe, expect, it } from '@effect/vitest';
import eventSeriesEventType from '@sideline/migrations/before/1794700000_event_series_event_type';
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

type Seeded = { teamId: string; memberId: string };

const seed = (label: string) =>
  Effect.gen(function* () {
    const user = yield* createUser(`es-type-${label}`);
    const team = yield* createTeam(nextDiscordId(), user.id);
    const member = yield* createTeamMember(team.id, user.id);
    return { teamId: team.id as string, memberId: member.id as string };
  });

type SeriesTypeRow = { id: string; event_type: string; event_type_id: string | null };

// Old-server shape: no type columns named at all.
const insertLegacySeries = (s: Seeded) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<SeriesTypeRow>`
        INSERT INTO event_series (team_id, title, start_time, frequency, days_of_week, start_date, created_by)
        VALUES (${s.teamId}, 'Series', '18:00'::time, 'weekly', '{1}'::integer[], '2099-01-01'::date, ${s.memberId})
        RETURNING id, event_type, event_type_id
      `,
    ),
    Effect.map((rows) => rows[0] as SeriesTypeRow),
  );

const insertTypedSeries = (s: Seeded, eventType: string, eventTypeId: string | null) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<SeriesTypeRow>`
        INSERT INTO event_series (team_id, title, start_time, frequency, days_of_week, start_date,
                                  created_by, event_type, event_type_id)
        VALUES (${s.teamId}, 'Series', '18:00'::time, 'weekly', '{1}'::integer[], '2099-01-01'::date,
                ${s.memberId}, ${eventType}, ${eventTypeId})
        RETURNING id, event_type, event_type_id
      `,
    ),
    Effect.map((rows) => rows[0] as SeriesTypeRow),
  );

// Kind omitted: only the id is named, so the column DEFAULT supplies 'training'.
const insertSeriesIdOnly = (s: Seeded, eventTypeId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<SeriesTypeRow>`
        INSERT INTO event_series (team_id, title, start_time, frequency, days_of_week, start_date,
                                  created_by, event_type_id)
        VALUES (${s.teamId}, 'Series', '18:00'::time, 'weekly', '{1}'::integer[], '2099-01-01'::date,
                ${s.memberId}, ${eventTypeId})
        RETURNING id, event_type, event_type_id
      `,
    ),
    Effect.map((rows) => rows[0] as SeriesTypeRow),
  );

const getSeries = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql<SeriesTypeRow>`SELECT id, event_type, event_type_id FROM event_series WHERE id = ${id}`,
    ),
    Effect.map((rows) => rows[0] as SeriesTypeRow),
  );

// What the EVENTS trigger picks for a kind-only insert in this team. The reference every series
// resolution is compared against.
const eventsTriggerPick = (s: Seeded, kind: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ event_type_id: string | null }>`
        INSERT INTO events (team_id, event_type, title, created_by, start_at)
        VALUES (${s.teamId}, ${kind}, 'Reference', ${s.memberId}, ${new Date('2099-06-15T18:00:00Z')})
        RETURNING event_type_id
      `,
    ),
    Effect.map((rows) => rows[0]?.event_type_id ?? null),
  );

const typeIdByKind = (teamId: string, kind: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        SELECT id FROM event_types
        WHERE team_id = ${teamId} AND kind = ${kind} AND archived_at IS NULL
        ORDER BY created_at, id LIMIT 1
      `,
    ),
    Effect.map((rows) => rows[0]?.id as string),
  );

const errorChain = (error: unknown): string => {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && typeof current === 'object' && current !== null; depth++) {
    if ('message' in current) chain.push(String(current.message));
    if ('code' in current) chain.push(String(current.code));
    if ('constraint' in current) chain.push(String(current.constraint));
    current = 'cause' in current ? current.cause : undefined;
  }
  return chain.join(' ');
};

describe('1794700000_event_series_event_type', () => {
  it.effect('an old-server INSERT (no type columns) lands as training with the events pick', () =>
    Effect.gen(function* () {
      const s = yield* seed('legacy');
      const series = yield* insertLegacySeries(s);
      const reference = yield* eventsTriggerPick(s, 'training');
      expect(series.event_type).toBe('training');
      expect(reference).not.toBeNull();
      expect(series.event_type_id).toBe(reference);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('backfill resolves NULL ids the way the events trigger does (active type wins)', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const a = yield* seed('bf-a');
      const b = yield* seed('bf-b');

      // Team B: archive the seeded training type and add a newer active one.
      yield* sql`
        UPDATE event_types SET archived_at = now()
        WHERE team_id = ${b.teamId} AND kind = 'training'
      `;
      yield* sql`
        INSERT INTO event_types (team_id, name, kind, color, position)
        VALUES (${b.teamId}, 'Newer training', 'training', 'blue', 99)
      `;

      const ids = yield* Effect.gen(function* () {
        yield* sql`ALTER TABLE event_series DISABLE TRIGGER event_series_sync_event_type_trg`;
        const sa = yield* insertLegacySeries(a);
        const sb = yield* insertLegacySeries(b);
        yield* sql`UPDATE event_series SET event_type_id = NULL`;
        yield* sql`ALTER TABLE event_series ENABLE TRIGGER event_series_sync_event_type_trg`;
        yield* eventSeriesEventType;
        return { sa: sa.id, sb: sb.id };
      }).pipe(sql.withTransaction);

      const rowA = yield* getSeries(ids.sa);
      const rowB = yield* getSeries(ids.sb);
      const pickA = yield* eventsTriggerPick(a, 'training');
      const pickB = yield* eventsTriggerPick(b, 'training');
      const activeB = yield* typeIdByKind(b.teamId, 'training');

      expect(rowA.event_type).toBe('training');
      expect(rowA.event_type_id).toBe(pickA);
      expect(rowB.event_type).toBe('training');
      expect(rowB.event_type_id).toBe(pickB);
      expect(rowB.event_type_id).toBe(activeB);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('is idempotent: a second run changes neither ids nor row count', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const s = yield* seed('idem');
      const series = yield* insertLegacySeries(s);

      yield* eventSeriesEventType.pipe(sql.withTransaction);
      const afterFirst = yield* getSeries(series.id);
      yield* eventSeriesEventType.pipe(sql.withTransaction);
      const afterSecond = yield* getSeries(series.id);
      const count = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM event_series`;

      expect(afterFirst.event_type_id).toBe(series.event_type_id);
      expect(afterSecond).toEqual(afterFirst);
      expect(count[0]?.n).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("an own-team id wins over a conflicting kind ('training' + match id → match)", () =>
    Effect.gen(function* () {
      const s = yield* seed('own-id');
      const matchId = yield* typeIdByKind(s.teamId, 'match');
      const series = yield* insertTypedSeries(s, 'training', matchId);
      expect(series.event_type).toBe('match');
      expect(series.event_type_id).toBe(matchId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a foreign team's id is discarded and the kind resolves in the own team", () =>
    Effect.gen(function* () {
      const s = yield* seed('foreign-own');
      const other = yield* seed('foreign-other');
      const foreignMatchId = yield* typeIdByKind(other.teamId, 'match');
      const ownTrainingId = yield* typeIdByKind(s.teamId, 'training');
      const series = yield* insertSeriesIdOnly(s, foreignMatchId);
      expect(series.event_type).toBe('training');
      expect(series.event_type_id).toBe(ownTrainingId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a kind-only UPDATE re-resolves the id within the team', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const s = yield* seed('kind-update');
      const series = yield* insertLegacySeries(s);
      yield* sql`UPDATE event_series SET event_type = 'social' WHERE id = ${series.id}`;
      const row = yield* getSeries(series.id);
      const socialId = yield* typeIdByKind(s.teamId, 'social');
      expect(row.event_type).toBe('social');
      expect(row.event_type_id).toBe(socialId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects event_type = 'bogus' with a CHECK violation (23514)", () =>
    Effect.gen(function* () {
      const s = yield* seed('bogus');
      const error = yield* Effect.flip(insertTypedSeries(s, 'bogus', null));
      expect(errorChain(error)).toContain('23514');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('deleting the team cascades through event_series without a trigger error', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const s = yield* seed('cascade');
      yield* insertLegacySeries(s);
      yield* sql`DELETE FROM teams WHERE id = ${s.teamId}`;
      const left = yield* sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM event_series WHERE team_id = ${s.teamId}`;
      expect(left[0]?.n).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
