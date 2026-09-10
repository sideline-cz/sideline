// Erasure is irreversible, so the properties below are the ones worth having
// a test for rather than a careful reading:
//
//   1. A dry run writes nothing. If that is wrong, "let me check first"
//      destroys the data it was meant to inspect.
//   2. It is idempotent. Someone handling a GDPR request will run it twice to
//      confirm it worked, and the second run must be a no-op.
//   3. Nobody else is touched. The statements are generated from a manifest,
//      so one mistake in the id plumbing erases everyone.
//   4. The identity is actually gone, and the referencing rows survive —
//      that is the whole premise of anonymising in place rather than deleting.

import { beforeEach, describe, expect, it } from '@effect/vitest';
import { Discord, type User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { eraseUser } from '~/gdpr/eraseUser.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = UsersRepository.Default.pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const createUser = (discordId: string, username: string, name: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: Discord.Snowflake.makeUnsafe(discordId),
        username,
        avatar: Option.some('avatar-hash'),
        discord_nickname: Option.some(name),
        discord_display_name: Option.some(name),
      }),
    ),
  );

const giveSession = (userId: User.UserId, token: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${userId}, ${token}, NOW() + INTERVAL '1 day')`,
    ),
  );

const readUser = (userId: User.UserId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{
          discord_id: string;
          username: string;
          avatar: string | null;
          discord_display_name: string | null;
        }>`SELECT discord_id, username, avatar, discord_display_name FROM users WHERE id = ${userId}`,
    ),
    Effect.map((rows) => rows[0]),
  );

const countSessions = (userId: User.UserId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = ${userId}`,
    ),
    Effect.map((rows) => rows[0].n),
  );

describe('eraseUser', () => {
  it.effect('a dry run writes nothing at all', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000101', 'dryrun', 'Dry Run');
      yield* giveSession(me.id, 'dry-session');

      const report = yield* eraseUser(me.id, { dryRun: true });

      expect(report.dryRun).toBe(true);
      expect(report.steps.length).toBeGreaterThan(0);

      // Everything still exactly as it was.
      const after = yield* readUser(me.id);
      expect(after.username).toBe('dryrun');
      expect(after.discord_display_name).toBe('Dry Run');
      expect(yield* countSessions(me.id)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('removes the identity and the credentials', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000102', 'erased', 'Real Name');
      yield* giveSession(me.id, 'live-session');

      yield* eraseUser(me.id, { dryRun: false });

      const after = yield* readUser(me.id);
      expect(after.username).toBe(`erased-${me.id}`);
      expect(after.discord_id).toBe(`erased-${me.id}`);
      expect(after.avatar).toBeNull();
      expect(after.discord_display_name).toBeNull();

      // Credentials are deleted, not pseudonymised — erasure has to revoke
      // access, not rename it.
      expect(yield* countSessions(me.id)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('keeps the row, so the foreign keys stay valid', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000103', 'kept', 'Kept');

      yield* eraseUser(me.id, { dryRun: false });

      // Anonymise in place: the row survives precisely so the 49 referencing
      // tables do not cascade away with it.
      const after = yield* readUser(me.id);
      expect(after).toBeDefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('is idempotent — a second run changes nothing further', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000104', 'twice', 'Twice');
      yield* giveSession(me.id, 'session-1');

      yield* eraseUser(me.id, { dryRun: false });
      const afterFirst = yield* readUser(me.id);

      yield* eraseUser(me.id, { dryRun: false });
      const afterSecond = yield* readUser(me.id);

      // The placeholder is derived from the row id, not random, so rerunning
      // does not churn the value.
      expect(afterSecond).toEqual(afterFirst);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('does not touch anybody else', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000105', 'target', 'Target');
      const bystander = yield* createUser('900000000000000106', 'bystander', 'Bystander');
      yield* giveSession(me.id, 'mine');
      yield* giveSession(bystander.id, 'theirs');

      yield* eraseUser(me.id, { dryRun: false });

      const other = yield* readUser(bystander.id);
      expect(other.username).toBe('bystander');
      expect(other.discord_display_name).toBe('Bystander');
      expect(yield* countSessions(bystander.id)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('reports what it deliberately kept, with reasons', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000107', 'report', 'Report');

      const report = yield* eraseUser(me.id, { dryRun: true });

      expect(report.kept.length).toBeGreaterThan(0);
      for (const kept of report.kept) expect(kept.reason.length).toBeGreaterThan(40);
      // Financial history is retained on purpose; §5 of the policy says so.
      expect(report.kept.map((k) => k.table)).toContain('payments');
    }).pipe(Effect.provide(TestLayer)),
  );
});
