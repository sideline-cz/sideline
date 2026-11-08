// Migration 1794800000 — activity_logs.season_id, season_at (Prague-date rule), the
// BEFORE INSERT / UPDATE OF logged_at trigger, and the narrow backfill.
//
// globalSetup runs migrations before any row exists, so the backfill is observed by running the
// migration effect again (case 3). Every case arranges its own seasons and logs: no case depends
// on run order. Requires a fresh `packages/migrations` build (tests load dist).

import { describe, expect, it } from '@effect/vitest';
import type { TeamMember } from '@sideline/domain';
import activityLogSeasons from '@sideline/migrations/before/1794800000_activity_log_seasons';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';
import { daysFromNow, readSeasons, setSeasons } from '../seasonFixtures.js';

const TestLayer = Layer.mergeAll(
  ActivityLogsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedGlobalTraining = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen(
    (sql) => sql`
      INSERT INTO activity_types (team_id, name, slug) VALUES (NULL, 'Training', 'training')
      ON CONFLICT (slug) WHERE team_id IS NULL DO NOTHING
    `,
  ),
);

// S1 = [now-100d, expires now-50d], S2 = [now-10d, open]
const S1_START = daysFromNow(-100);
const S1_EXPIRES = daysFromNow(-50);

/** Team + member + the two-season fixture. Returns the season ids. */
const seed = Effect.Do.pipe(
  Effect.tap(() => seedGlobalTraining),
  Effect.bind('owner', () => createUser('als-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.bind('member', ({ team, owner }) => createTeamMember(team.id, owner.id)),
  Effect.tap(({ team }) =>
    setSeasons(team.id, [
      { startsAt: S1_START, expiresAt: S1_EXPIRES },
      { startsAt: daysFromNow(-10) },
    ]),
  ),
  Effect.bind('seasons', ({ team }) => readSeasons(team.id)),
  Effect.map(({ team, member, seasons }) => ({
    teamId: team.id as string,
    memberId: member.id as TeamMember.TeamMemberId,
    s1: seasons[0]?.id as string,
    s2: seasons[1]?.id as string,
  })),
);

/** Raw insert; `at` is a Date or a SQL expression string (trusted, test-only). */
const insertLog = (memberId: string, at: Date | string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ id: string; season_id: string | null }>`
        INSERT INTO activity_logs (team_member_id, activity_type_id, logged_at, source)
        SELECT ${memberId}, at.id, ${typeof at === 'string' ? sql.unsafe(at) : at}, 'manual'
        FROM activity_types at WHERE at.slug = 'training' AND at.team_id IS NULL
        RETURNING id::text AS id, season_id::text AS season_id
      `,
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return row;
    }),
  );

const seasonOf = (logId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ season_id: string | null }>`
        SELECT season_id::text AS season_id FROM activity_logs WHERE id = ${logId}
      `,
    ),
    Effect.map((rows) => rows[0]?.season_id ?? null),
  );

const countLogs = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen((sql) => sql<{ n: number }>`SELECT count(*)::int AS n FROM activity_logs`),
  Effect.map((rows) => rows[0]?.n ?? -1),
);

/** The case-1 logs, in a fixed order, with their expected season ("s1" | "s2" | null). */
const insertCase1Logs = (memberId: string) =>
  Effect.all([
    insertLog(memberId, daysFromNow(-80)),
    insertLog(memberId, S1_START),
    insertLog(memberId, S1_EXPIRES),
    insertLog(memberId, daysFromNow(-30)),
    insertLog(memberId, daysFromNow(-200)),
    insertLog(memberId, daysFromNow(-1)),
  ]);

const PRAGUE_TODAY = `(now() AT TIME ZONE 'Europe/Prague')::date`;

describe('migration 1794800000 — activity_logs.season_id', () => {
  it.effect('insert derives season', () =>
    Effect.gen(function* () {
      const { memberId, s1, s2 } = yield* seed;
      const logs = yield* insertCase1Logs(memberId);
      expect(logs.map((l) => l.season_id)).toEqual([s1, s1, null, null, null, s2]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('update of logged_at re-derives; other updates do not', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const { memberId, s1, s2 } = yield* seed;

      const moved = yield* insertLog(memberId, daysFromNow(-1));
      yield* sql`UPDATE activity_logs SET logged_at = ${daysFromNow(-80)} WHERE id = ${moved.id}`;
      expect(yield* seasonOf(moved.id)).toBe(s1);

      const kept = yield* insertLog(memberId, daysFromNow(-8));
      expect(kept.season_id).toBe(s2);
      // S2 now starts after the log; a note-only edit must not re-derive (stable at write).
      yield* sql`UPDATE seasons SET starts_at = now() - interval '5 days' WHERE id = ${s2}`;
      yield* sql`UPDATE activity_logs SET note = 'x', logged_at = logged_at WHERE id = ${kept.id}`;
      expect(yield* seasonOf(kept.id)).toBe(s2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('backfill restores NULLs, is idempotent, deletes nothing', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const { memberId } = yield* seed;
      const logs = yield* insertCase1Logs(memberId);
      const before = yield* countLogs;

      yield* sql`UPDATE activity_logs SET season_id = NULL`;
      yield* activityLogSeasons;
      yield* activityLogSeasons;

      const after = yield* Effect.all(logs.map((l) => seasonOf(l.id)));
      expect(after).toEqual(logs.map((l) => l.season_id));
      expect(yield* countLogs).toBe(before);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('deleting a season nulls its logs, keeps the rows', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const { memberId, s1 } = yield* seed;
      const a = yield* insertLog(memberId, daysFromNow(-80));
      const b = yield* insertLog(memberId, S1_START);
      expect([a.season_id, b.season_id]).toEqual([s1, s1]);
      const before = yield* countLogs;

      yield* sql`DELETE FROM seasons WHERE id = ${s1}`;

      expect(yield* seasonOf(a.id)).toBeNull();
      expect(yield* seasonOf(b.id)).toBeNull();
      expect(yield* countLogs).toBe(before);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('auto-log dedup unaffected', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const repo = yield* ActivityLogsRepository.asEffect();
      const { memberId, s2 } = yield* seed;
      const at = new Date();
      yield* repo.insertAutoIgnoreConflict({ team_member_id: memberId, logged_at: at });
      yield* repo.insertAutoIgnoreConflict({ team_member_id: memberId, logged_at: at });

      const rows = yield* sql<{ season_id: string | null }>`
        SELECT season_id::text AS season_id FROM activity_logs WHERE team_member_id = ${memberId}
      `;
      expect(rows).toEqual([{ season_id: s2 }]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('first day: a season starting later today covers the whole Prague day', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const { teamId, memberId } = yield* seed;
      yield* setSeasons(teamId, []);
      const [season] = yield* sql<{ id: string }>`
        INSERT INTO seasons (team_id, starts_at)
        VALUES (${teamId}, ((${sql.unsafe(PRAGUE_TODAY)} + time '15:00') AT TIME ZONE 'Europe/Prague'))
        RETURNING id::text AS id
      `;

      // Prague noon today is BEFORE the 15:00 start instant: an instant rule gives NULL here.
      const noon = yield* insertLog(
        memberId,
        `((${PRAGUE_TODAY} + time '12:00') AT TIME ZONE 'Europe/Prague')`,
      );
      const yesterdayLate = yield* insertLog(
        memberId,
        `(((${PRAGUE_TODAY} - 1) + time '23:30') AT TIME ZONE 'Europe/Prague')`,
      );
      const [current] = yield* sql<{ id: string | null }>`
        SELECT current_season_id(${teamId}::uuid)::text AS id
      `;

      expect(noon.season_id).toBe(season?.id);
      expect(yesterdayLate.season_id).toBeNull();
      expect(current?.id).toBe(season?.id);
    }).pipe(Effect.provide(TestLayer)),
  );
});
