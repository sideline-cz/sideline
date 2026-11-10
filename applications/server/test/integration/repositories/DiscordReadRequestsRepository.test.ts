// `discord_read_requests` on real Postgres: the claim, the first-write-wins result, the read-once
// delete, the 30 s age gate, the timeout `abandon` (which must keep a late result), the 5-minute
// sweep and the team cascade. Every one of these is a property of the SQL, so none of it can be
// asserted against a mock.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, DiscordReadRequest, Team } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { DiscordReadRequestsRepository } from '~/repositories/DiscordReadRequestsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  DiscordReadRequestsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const CHANNEL = '710000000000000009' as Discord.Snowflake;

const makeTeam = Effect.gen(function* () {
  const users = yield* UsersRepository.asEffect();
  const teams = yield* TeamsRepository.asEffect();
  const user = yield* users.upsertFromDiscord({
    discord_id: '710000000000000001' as Discord.Snowflake,
    username: 'discord-read-fixture',
    avatar: Option.none(),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
  });
  const team = yield* teams.insert({
    name: 'Discord Read Test',
    guild_id: '710000000000000002' as Discord.Snowflake,
    created_by: user.id,
    description: Option.none(),
    sport: Option.none(),
    logo_url: Option.none(),
    created_at: undefined,
    updated_at: undefined,
    welcome_channel_id: Option.none(),
    system_log_channel_id: Option.none(),
    welcome_message_template: Option.none(),
    rules_channel_id: Option.none(),
    achievement_channel_id: Option.none(),
    onboarding_rules_role_id: Option.none(),
    onboarding_rules_prompt_id: Option.none(),
    onboarding_locale: 'en',
    onboarding_synced_at: Option.none(),
    onboarding_sync_status: 'pending',
    onboarding_sync_error: Option.none(),
  });
  return team.id as Team.TeamId;
});

const insertRequest = (teamId: Team.TeamId, sinceHours: Option.Option<number> = Option.none()) =>
  DiscordReadRequestsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insert({ teamId, channelId: CHANNEL, sinceHours, limit: 50 })),
  );

const okResult = (content: string): DiscordReadRequest.DiscordReadResult => ({
  outcome: 'ok',
  messages: [{ author: 'Ann', content, timestamp: '2026-11-10T10:00:00.000Z' }],
  capped: false,
});

const rowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM discord_read_requests`;
  return rows[0]?.n ?? 0;
});

describe('DiscordReadRequestsRepository', () => {
  it.effect('pick then submit: the row is claimed, then no longer returned', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const sql = yield* SqlClient.SqlClient;
      const teamId = yield* makeTeam;
      const id = yield* insertRequest(teamId);

      const picked = yield* repo.pickUnprocessed(10);
      expect(picked.map((r) => r.id)).toEqual([id]);
      expect(picked[0]?.channel_id).toBe(CHANNEL);
      expect(picked[0]?.message_limit).toBe(50);
      expect(Option.isNone(picked[0]?.since_at ?? Option.some(0))).toBe(true);
      const claimed = yield* sql<{ picked: boolean }>`
        SELECT picked_at IS NOT NULL AS picked FROM discord_read_requests WHERE id = ${id}
      `;
      expect(claimed[0]?.picked).toBe(true);

      yield* repo.submitResult(id, okResult('hi'));
      expect(yield* repo.pickUnprocessed(10)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a since window is stored as a cutoff on the DB clock', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const teamId = yield* makeTeam;
      yield* insertRequest(teamId, Option.some(2));

      const picked = yield* repo.pickUnprocessed(10);
      expect(Option.isSome(picked[0]?.since_at ?? Option.none())).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('submit is idempotent: the first result wins', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const teamId = yield* makeTeam;
      const id = yield* insertRequest(teamId);

      yield* repo.submitResult(id, okResult('first'));
      yield* repo.submitResult(id, okResult('second'));

      expect(yield* repo.consume(id)).toEqual(Option.some(okResult('first')));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('consume is read-once and returns what was submitted', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const teamId = yield* makeTeam;
      const id = yield* insertRequest(teamId);

      expect(Option.isNone(yield* repo.consume(id))).toBe(true);
      expect(yield* rowCount).toBe(1);

      yield* repo.submitResult(id, okResult('hello'));
      expect(yield* repo.consume(id)).toEqual(Option.some(okResult('hello')));
      expect(yield* rowCount).toBe(0);
      expect(Option.isNone(yield* repo.consume(id))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('age gate: a row older than 30 seconds is not picked', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const sql = yield* SqlClient.SqlClient;
      const teamId = yield* makeTeam;
      const id = yield* insertRequest(teamId);
      yield* sql`
        UPDATE discord_read_requests SET created_at = now() - interval '31 seconds' WHERE id = ${id}
      `;

      expect(yield* repo.pickUnprocessed(10)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('abandon reports whether the bot picked the row, and None for a missing id', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const teamId = yield* makeTeam;

      const unpicked = yield* insertRequest(teamId);
      expect(yield* repo.abandon(unpicked)).toEqual(
        Option.some({ picked: false, result: Option.none() }),
      );

      const picked = yield* insertRequest(teamId);
      yield* repo.pickUnprocessed(10);
      expect(yield* repo.abandon(picked)).toEqual(
        Option.some({ picked: true, result: Option.none() }),
      );

      expect(Option.isNone(yield* repo.abandon(picked))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('abandon keeps a late result (the timeout race)', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const teamId = yield* makeTeam;
      const id = yield* insertRequest(teamId);
      yield* repo.pickUnprocessed(10);
      yield* repo.submitResult(id, okResult('late'));

      expect(yield* repo.abandon(id)).toEqual(
        Option.some({ picked: true, result: Option.some(okResult('late')) }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('sweep deletes rows older than the TTL, processed or not, and keeps fresh ones', () =>
    Effect.gen(function* () {
      const repo = yield* DiscordReadRequestsRepository.asEffect();
      const sql = yield* SqlClient.SqlClient;
      const teamId = yield* makeTeam;
      const oldProcessed = yield* insertRequest(teamId);
      yield* repo.submitResult(oldProcessed, okResult('x'));
      const oldPending = yield* insertRequest(teamId);
      const fresh = yield* insertRequest(teamId);
      yield* sql`
        UPDATE discord_read_requests SET created_at = now() - interval '6 minutes'
        WHERE id IN (${oldProcessed}, ${oldPending})
      `;

      expect(yield* repo.sweepOlderThan(5)).toBe(2);
      const left = yield* sql<{ id: string }>`SELECT id FROM discord_read_requests`;
      expect(left.map((r) => r.id)).toEqual([fresh]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('deleting the team deletes its rows', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const teamId = yield* makeTeam;
      yield* insertRequest(teamId);

      yield* sql`DELETE FROM teams WHERE id = ${teamId}`;
      expect(yield* rowCount).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
