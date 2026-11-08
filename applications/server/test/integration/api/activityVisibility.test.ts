// Activity visibility + seasons over HTTP: listLogs (cross-member read, note stripping, season
// filter), getMemberStats / getLeaderboard (season scope, streaks), getActivityMatrix.
// Pattern: membershipPlans.test.ts — a SmallApi, mocked SessionsRepository, real repositories.
//
// Fixture (team T1): A [member:view]; B [member:view] with the logs below; C [] with one own log
// in Q; E inactive with a log; group G = {B}. Team T2: D, group G2 = {D}. User X in no team.
// Seasons on T1: P = [now-200d, expires now-100d], Q = [now-50d, open] (current), F = [now+30d].
// B's logs: Prague noon today-1 gym 30 "secret-note" + running 15 (Q), noon today-150 (P),
// now-300d (Earlier), noon today-29 (Q), noon today-30 (Q, outside the matrix window).
// So: Q count 4; lifetime longest streak 2 (today-30, today-29); P longest 1; current streak 1.

import { describe, expect, it } from '@effect/vitest';
import type { GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { ActivityLogApi, ActivityStatsApi, LeaderboardApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { ActivityLogApiLive } from '~/api/activity-logs.js';
import { ActivityStatsApiLive } from '~/api/activity-stats.js';
import { LeaderboardApiLive } from '~/api/leaderboard.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';
import { daysFromNow, readSeasons, setSeasons } from '../seasonFixtures.js';

const SmallApi = HttpApi.make('api')
  .add(ActivityLogApi.ActivityLogApiGroup)
  .add(ActivityStatsApi.ActivityStatsApiGroup)
  .add(LeaderboardApi.LeaderboardApiGroup);

let sessionsStore: Map<string, User.UserId>;

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as any);

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  ActivityLogsRepository.Default,
  ActivityTypesRepository.Default,
  GroupsRepository.Default,
  EarnedAchievementsRepository.Default,
  LeaderboardRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(Layer.mergeAll(ActivityLogApiLive, ActivityStatsApiLive, LeaderboardApiLive)),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore = new Map();
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const runSeeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SeedLayer)) as Effect.Effect<A, E, never>);

const addMember = (teamId: Team.TeamId, userId: User.UserId, active = true) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

const giveRole = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  permissions: ReadonlyArray<Role.Permission>,
) =>
  Effect.Do.pipe(
    Effect.bind('roles', () => RolesRepository.asEffect()),
    Effect.bind('role', ({ roles }) => roles.insertRole(teamId, `role-${memberId}`)),
    Effect.tap(({ roles, role }) => roles.setRolePermissions(role.id, permissions)),
    Effect.tap(({ role }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.assignRole(memberId, role.id)),
      ),
    ),
  );

const addGroup = (teamId: Team.TeamId, name: string, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()).pipe(
        Effect.tap((g) => repo.addMemberById(g.id, memberId)),
        Effect.map((g) => g.id as GroupModel.GroupId),
      ),
    ),
  );

const seedTypes = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen(
    (sql) => sql`
      INSERT INTO activity_types (team_id, name, slug)
      VALUES (NULL, 'Gym', 'gym'), (NULL, 'Running', 'running')
      ON CONFLICT (slug) WHERE team_id IS NULL DO NOTHING
    `,
  ),
);

// SQL timestamp expressions (trusted, test-only).
const pragueNoon = (daysAgo: number) =>
  `((((now() AT TIME ZONE 'Europe/Prague')::date - ${daysAgo}) + time '12:00') AT TIME ZONE 'Europe/Prague')`;

const insertLog = (
  memberId: string,
  slug: 'gym' | 'running',
  at: string,
  opts: { minutes?: number; note?: string } = {},
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO activity_logs
          (team_member_id, activity_type_id, logged_at, duration_minutes, note, source)
        SELECT ${memberId}, at.id, ${sql.unsafe(at)}, ${opts.minutes ?? null},
               ${opts.note ?? null}, 'manual'
        FROM activity_types at WHERE at.slug = ${slug} AND at.team_id IS NULL
      `,
    ),
  );

const seedFixture = () =>
  runSeeded(
    Effect.gen(function* () {
      yield* seedTypes;
      const users = {
        a: (yield* createUser('va')).id,
        b: (yield* createUser('vb')).id,
        c: (yield* createUser('vc')).id,
        d: (yield* createUser('vd')).id,
        e: (yield* createUser('ve')).id,
        x: (yield* createUser('vx')).id,
      };
      const t1 = (yield* createTeam(nextDiscordId(), users.a, 'T1')).id;
      const t2 = (yield* createTeam(nextDiscordId(), users.d, 'T2')).id;

      yield* setSeasons(t1, [
        { startsAt: daysFromNow(-200), expiresAt: daysFromNow(-100) },
        { startsAt: daysFromNow(-50) },
        { startsAt: daysFromNow(30) },
      ]);
      const [p, q, f] = yield* readSeasons(t1);

      const a = yield* addMember(t1, users.a);
      const b = yield* addMember(t1, users.b);
      const c = yield* addMember(t1, users.c);
      const e = yield* addMember(t1, users.e, false);
      const d = yield* addMember(t2, users.d);
      yield* giveRole(t1, a, ['member:view']);
      yield* giveRole(t1, b, ['member:view']);
      yield* giveRole(t1, c, []);

      yield* insertLog(b, 'gym', pragueNoon(1), { minutes: 30, note: 'secret-note' });
      yield* insertLog(b, 'running', pragueNoon(1), { minutes: 15 });
      yield* insertLog(b, 'gym', pragueNoon(150));
      yield* insertLog(b, 'gym', `(now() - interval '300 days')`);
      yield* insertLog(b, 'gym', pragueNoon(29));
      yield* insertLog(b, 'gym', pragueNoon(30));
      yield* insertLog(c, 'gym', pragueNoon(2));
      yield* insertLog(e, 'gym', pragueNoon(3));
      yield* insertLog(d, 'gym', pragueNoon(3), { note: 'd-note' });

      const g = yield* addGroup(t1, 'G', b);
      const g2 = yield* addGroup(t2, 'G2', d);

      for (const key of ['a', 'b', 'c', 'x'] as const) sessionsStore.set(key, users[key]);

      return {
        t1,
        members: { a, b, c, d, e },
        seasons: { p: p?.id as string, q: q?.id as string, f: f?.id as string },
        g,
        g2,
      };
    }),
  );

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

const get = async (token: string, path: string) => {
  const response = await handler(
    new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${token}` } }),
  );
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
};

const logsPath = (f: Fixture, memberId: string, query = '') =>
  `/teams/${f.t1}/members/${memberId}/activity-logs${query}`;
const statsPath = (f: Fixture, memberId: string, query = '') =>
  `/teams/${f.t1}/members/${memberId}/activity-stats${query}`;
const matrixPath = (f: Fixture, query = '') => `/teams/${f.t1}/activity-matrix${query}`;
const leaderboardPath = (f: Fixture, query = '') => `/teams/${f.t1}/leaderboard${query}`;

const PRAGUE_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(
  new Date(),
);
const pragueDay = (daysAgo: number) => {
  const d = new Date(`${PRAGUE_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

const leaderboardEntry = (body: any, memberId: string) =>
  body.entries.find((e: any) => e.teamMemberId === memberId);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('activity visibility and seasons', () => {
  it("member with member:view reads another member's logs without notes", async () => {
    const f = await seedFixture();
    const res = await get('a', logsPath(f, f.members.b));
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeGreaterThan(0);
    for (const log of res.body.logs) expect(log.note).toBeNull();
    expect(res.text).not.toContain('secret-note');
  });

  it('owner reads own notes', async () => {
    const f = await seedFixture();
    const res = await get('b', logsPath(f, f.members.b));
    expect(res.status).toBe(200);
    expect(res.body.logs.map((l: any) => l.note)).toContain('secret-note');
  });

  it('member without member:view: Forbidden for others and for the matrix, own logs and own stats still readable', async () => {
    const f = await seedFixture();

    const othersLogs = await get('c', logsPath(f, f.members.b));
    expect(othersLogs.status).toBe(403);
    expect(othersLogs.body._tag).toBe('ActivityLogForbidden');

    // ActivityStatsApi errors carry no HttpApiSchema.status, so the wire status is not 403; the
    // tag is the contract here.
    const othersStats = await get('c', statsPath(f, f.members.b));
    expect(othersStats.body._tag).toBe('ActivityStatsForbidden');

    expect((await get('c', matrixPath(f))).status).toBe(403);
    expect((await get('c', logsPath(f, f.members.c))).status).toBe(200);

    const ownStats = await get('c', statsPath(f, f.members.c));
    expect(ownStats.status).toBe(200);
    expect(ownStats.body.totalActivities).toBe(1);
  });

  it('non-member and cross-team are refused', async () => {
    const f = await seedFixture();
    expect((await get('x', logsPath(f, f.members.b))).status).toBe(403);
    expect((await get('x', matrixPath(f))).status).toBe(403);

    const crossTeam = await get('a', logsPath(f, f.members.d));
    expect(crossTeam.status).toBe(404);
    expect(crossTeam.body._tag).toBe('ActivityLogMemberNotFound');
    expect(crossTeam.text).not.toContain('d-note');
  });

  it('writes stay self-only', async () => {
    const f = await seedFixture();
    const gymId = await runSeeded(
      SqlClient.SqlClient.asEffect().pipe(
        Effect.andThen(
          (sql) =>
            sql<{ id: string }>`SELECT id::text AS id FROM activity_types WHERE slug = 'gym'`,
        ),
        Effect.map((rows) => rows[0]?.id),
      ),
    );
    const res = await handler(
      new Request(`http://localhost${logsPath(f, f.members.b)}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer a', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activityTypeId: gymId,
          durationMinutes: null,
          note: null,
          loggedAtDate: null,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('season filter', async () => {
    const f = await seedFixture();

    const byDefault = await get('b', logsPath(f, f.members.b));
    expect(byDefault.body.logs).toHaveLength(4);

    const past = await get('b', logsPath(f, f.members.b, `?season=${f.seasons.p}`));
    expect(past.body.logs).toHaveLength(1);

    const earlier = await get('b', logsPath(f, f.members.b, '?season=earlier'));
    expect(earlier.body.logs).toHaveLength(1);
    expect(earlier.body.logs[0].loggedAt < pragueDay(250)).toBe(true);

    expect(byDefault.body.seasons.map((s: any) => [s.id, s.isCurrent])).toEqual([
      [f.seasons.q, true],
      [f.seasons.p, false],
    ]);

    expect((await get('b', logsPath(f, f.members.b, '?season=not-a-uuid'))).status).toBe(400);
  });

  it('stats and leaderboard: current-season default, current id = default, streaks scoped with al2', async () => {
    const f = await seedFixture();
    const b = f.members.b;

    const stats = await get('b', statsPath(f, b));
    expect(stats.body.totalActivities).toBe(4);
    expect(stats.body.currentStreak).toBe(1);
    // 0 here means the current season id was not normalized to 'current'.
    expect((await get('b', statsPath(f, b, `?season=${f.seasons.q}`))).body.currentStreak).toBe(1);
    const statsEarlier = await get('b', statsPath(f, b, '?season=earlier'));
    expect(statsEarlier.body.totalActivities).toBe(1);
    expect(statsEarlier.body.currentStreak).toBe(0);

    const lbDefault = leaderboardEntry((await get('a', leaderboardPath(f))).body, b);
    expect(lbDefault.totalActivities).toBe(4);
    expect(lbDefault.currentStreak).toBe(1);
    const lbQ = leaderboardEntry(
      (await get('a', leaderboardPath(f, `?season=${f.seasons.q}`))).body,
      b,
    );
    expect(lbQ.currentStreak).toBe(1);
    const lbAll = leaderboardEntry((await get('a', leaderboardPath(f, '?timeframe=all'))).body, b);
    expect(lbAll.totalActivities).toBe(6);
    expect(lbAll.longestStreak).toBe(2);

    // Lifetime dates give 2: this fails if the activity_dates subquery is unscoped or uses al.
    const lbP = leaderboardEntry(
      (await get('a', leaderboardPath(f, `?season=${f.seasons.p}`))).body,
      b,
    );
    expect(lbP.longestStreak).toBe(1);
    expect(lbP.currentStreak).toBe(0);
  });

  it('matrix: 30-day window, no notes, active members, group filter', async () => {
    const f = await seedFixture();

    const res = await get('a', matrixPath(f));
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(30);
    expect(res.body.days.at(-1)).toBe(PRAGUE_TODAY);
    expect(res.text).not.toContain('secret-note');

    const rowIds = res.body.rows.map((r: any) => r.memberId);
    expect(rowIds).not.toContain(f.members.e);
    const bRow = res.body.rows.find((r: any) => r.memberId === f.members.b);
    const bDates = bRow.cells.map((c: any) => c.date);
    expect(bDates).toContain(pragueDay(29));
    expect(bDates).not.toContain(pragueDay(30));
    const yesterday = bRow.cells.find((c: any) => c.date === pragueDay(1));
    expect(yesterday.entries.map((e: any) => [e.activityTypeName, e.totalMinutes]).sort()).toEqual([
      ['Gym', 30],
      ['Running', 15],
    ]);

    const inG = await get('a', matrixPath(f, `?group=${f.g}`));
    expect(inG.body.rows.map((r: any) => r.memberId)).toEqual([f.members.b]);

    const foreign = await get('a', matrixPath(f, `?group=${f.g2}`));
    expect(foreign.status).toBe(200);
    expect(foreign.body.rows).toEqual([]);

    expect((await get('a', matrixPath(f, '?group=not-a-uuid'))).status).toBe(400);
  });
});
