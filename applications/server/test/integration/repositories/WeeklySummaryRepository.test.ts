import { describe, expect, it } from '@effect/vitest';
import { DateTime, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { WeeklySummaryRepository } from '~/repositories/WeeklySummaryRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  WeeklySummaryRepository.Default,
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

const WEEK_START = DateTime.makeUnsafe('2026-01-04T23:00:00.000Z');
const WEEK_END = DateTime.makeUnsafe('2026-01-11T22:59:59.999Z');

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// Seeds one member with logs inside and outside the week; pg hands timestamptz back as a JS Date
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO activity_types (team_id, name, slug)
    VALUES (NULL, 'Gym', 'gym')
    ON CONFLICT (slug) WHERE team_id IS NULL DO NOTHING
  `;
  const user = yield* createUser('weekly');
  const team = yield* createTeam(nextDiscordId(), user.id);
  const member = yield* createTeamMember(team.id, user.id);
  for (const at of ['2026-01-06T10:00:00Z', '2026-01-04T21:00:00Z', '2026-01-12T00:00:00Z']) {
    yield* sql`
      INSERT INTO activity_logs (team_member_id, activity_type_id, logged_at, source)
      SELECT ${member.id}, at.id, ${at}::timestamptz, 'manual'
      FROM activity_types at WHERE at.slug = 'gym' AND at.team_id IS NULL
    `;
  }
  return { teamId: team.id, memberId: member.id };
});

describe('WeeklySummaryRepository — integration', () => {
  it.effect('decodes the logs of a non-empty week', () =>
    Effect.gen(function* () {
      const { teamId, memberId } = yield* seed;
      const repo = yield* WeeklySummaryRepository.asEffect();

      const player = yield* repo.findPlayerWeekActivity(teamId, memberId, WEEK_START, WEEK_END);
      expect(player.map((r) => DateTime.formatIso(r.logged_at))).toEqual([
        '2026-01-06T10:00:00.000Z',
      ]);

      const team = yield* repo.findTeamWeekActivity(teamId, WEEK_START, WEEK_END);
      expect(team).toHaveLength(1);

      const allTime = yield* repo.findAllTimeLogsForMember(memberId);
      expect(allTime).toHaveLength(3);
    }).pipe(Effect.provide(TestLayer)),
  );
});
