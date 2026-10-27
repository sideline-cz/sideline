// Spec for `DiscordLoginTokensRepository` (`src/repositories/DiscordLoginTokensRepository.ts`).
//
// Docker-backed (testcontainers) on purpose. Every property this feature leans on is a
// real-Postgres fact a mocked `SqlClient` cannot produce: the atomic claim's
// `WHERE consumed_at IS NULL` losing its row on the second attempt, `expires_at > now()`
// against the server clock, and `withTransaction` actually committing the revoke and the
// insert together.

import { describe, expect, it } from '@effect/vitest';
import type { Auth, Discord } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { DiscordLoginTokensRepository } from '~/repositories/DiscordLoginTokensRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { generateUrlToken } from '~/utils/urlToken.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  DiscordLoginTokensRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const createUser = (discordId: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username: `u-${discordId}`,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000);

/** Issue a link and hand back the plaintext, the way the RPC handler does. */
const issueFor = (userId: Auth.UserId, expires = minutesFromNow(5)) =>
  Effect.Do.pipe(
    Effect.bind('repo', () => DiscordLoginTokensRepository.asEffect()),
    Effect.bind('generated', () => generateUrlToken()),
    Effect.tap(({ repo, generated }) =>
      repo.issue({
        token_hash: generated.hash,
        user_id: userId,
        issued_from_guild_id: Option.none(),
        expires_at: expires,
      }),
    ),
    Effect.map(({ generated }) => generated),
  );

const redeem = (hash: string) =>
  Effect.Do.pipe(
    Effect.bind('repo', () => DiscordLoginTokensRepository.asEffect()),
    Effect.bind('session', () => generateUrlToken()),
    Effect.flatMap(({ repo, session }) =>
      repo.redeem({
        token_hash: hash,
        session_token: session.token,
        session_expires_at: minutesFromNow(60 * 24 * 7),
      }),
    ),
  );

describe('DiscordLoginTokensRepository', () => {
  // THE acceptance criterion: used twice, second attempt fails.
  it.effect('a link redeems once and is dead on the second attempt', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('700000000000000001');
      const generated = yield* issueFor(userId);

      const first = yield* redeem(generated.hash);
      const second = yield* redeem(generated.hash);

      expect(Option.isSome(first)).toBe(true);
      expect(Option.getOrThrow(first).user_id).toBe(userId);
      expect(Option.isNone(second)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a successful redemption mints exactly one session for that user', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* createUser('700000000000000002');
      const generated = yield* issueFor(userId);

      yield* redeem(generated.hash);

      const sessions = yield* sql<{
        user_id: string;
      }>`SELECT user_id FROM sessions WHERE user_id = ${userId}`;
      expect(sessions.length).toBe(1);

      // The row points at the session it minted — this is the audit trail and the
      // handle a future revoke-the-session feature needs.
      const rows = yield* sql<{
        session_id: string | null;
        consumed_at: Date | null;
      }>`SELECT session_id, consumed_at FROM discord_login_tokens WHERE user_id = ${userId}`;
      expect(rows[0]?.session_id).not.toBeNull();
      expect(rows[0]?.consumed_at).not.toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a second redemption mints no second session', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* createUser('700000000000000003');
      const generated = yield* issueFor(userId);

      yield* redeem(generated.hash);
      yield* redeem(generated.hash);

      const sessions = yield* sql`SELECT 1 FROM sessions WHERE user_id = ${userId}`;
      expect(sessions.length).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an expired link fails closed', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('700000000000000004');
      const generated = yield* issueFor(userId, minutesFromNow(-1));

      const result = yield* redeem(generated.hash);

      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an unknown token fails closed', () =>
    Effect.gen(function* () {
      yield* createUser('700000000000000005');
      const result = yield* redeem('not-a-real-hash');
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  // The withdrawal story. "That link went somewhere wrong" is answered by running
  // /login again, and this is what makes that true.
  it.effect('issuing a new link revokes the previous one', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('700000000000000006');
      const first = yield* issueFor(userId);
      const second = yield* issueFor(userId);

      expect(Option.isNone(yield* redeem(first.hash))).toBe(true);
      expect(Option.isSome(yield* redeem(second.hash))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('revocation is scoped to the asking user', () =>
    Effect.gen(function* () {
      const alice = yield* createUser('700000000000000007');
      const bob = yield* createUser('700000000000000008');
      const aliceLink = yield* issueFor(alice);
      yield* issueFor(bob);

      expect(Option.isSome(yield* redeem(aliceLink.hash))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Issuing already-consumed links must not resurrect or re-revoke them: the audit
  // trail of what was actually used has to survive.
  it.effect('issuing does not disturb an already-consumed row', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* createUser('700000000000000009');
      const first = yield* issueFor(userId);
      yield* redeem(first.hash);
      yield* issueFor(userId);

      const rows = yield* sql<{
        revoked_at: Date | null;
      }>`SELECT revoked_at FROM discord_login_tokens WHERE token_hash = ${first.hash}`;
      expect(rows[0]?.revoked_at).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // The plaintext must never be recoverable from the database.
  it.effect('stores only the hash, never the token', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userId = yield* createUser('700000000000000010');
      const generated = yield* issueFor(userId);

      const rows = yield* sql<{
        token_hash: string;
      }>`SELECT token_hash FROM discord_login_tokens WHERE user_id = ${userId}`;
      expect(rows[0]?.token_hash).toBe(generated.hash);
      expect(rows[0]?.token_hash).not.toBe(generated.token);
      expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    }).pipe(Effect.provide(TestLayer)),
  );
});
