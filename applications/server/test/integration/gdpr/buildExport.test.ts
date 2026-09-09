// The two properties that make an export safe to hand someone.
//
// 1. It contains no credentials. An export is a file people download, mail to
//    themselves and keep; a live session or OAuth refresh token in it turns a
//    privacy feature into a credential leak.
// 2. It contains nobody else's data. Getting this wrong is a breach, and the
//    query is generated from a manifest rather than hand-written per table, so
//    a single mistake in the id plumbing would leak every row of every table.
//
// Both are asserted against a real database with two users present, because
// isolation cannot be demonstrated with only one.

import { beforeEach, describe, expect, it } from '@effect/vitest';
import { Auth, Discord, type User } from '@sideline/domain';
import { Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { buildExport } from '~/gdpr/buildExport.js';
import { NEVER_EXPORT_COLUMNS } from '~/gdpr/exportManifest.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(UsersRepository.Default, TeamsRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: Discord.Snowflake.makeUnsafe(discordId),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
  );

/** A session row exists purely so the redaction assertion has something to hide. */
const giveSession = (userId: User.UserId, token: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${userId}, ${token}, NOW() + INTERVAL '1 day')`,
    ),
  );

describe('buildExport', () => {
  it.effect('never emits a redacted column, and never its value', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000001', 'me');
      yield* giveSession(me.id, 'super-secret-session-token');

      const bundle = yield* buildExport(me.id);
      const serialised = JSON.stringify(bundle.data);

      // The token value itself must be nowhere in the payload.
      expect(serialised).not.toContain('super-secret-session-token');

      // Nor may any redacted column appear as a key.
      for (const qualified of NEVER_EXPORT_COLUMNS) {
        const column = qualified.split('.')[1];
        for (const rows of Object.values(bundle.data)) {
          for (const row of rows) {
            expect(Object.keys(row), `${qualified} leaked into the export`).not.toContain(column);
          }
        }
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('still exports the row the redacted column belonged to', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000002', 'me2');
      yield* giveSession(me.id, 'another-secret');

      const bundle = yield* buildExport(me.id);

      // Redaction hides the credential, not the fact that a session exists —
      // "you have three active sessions" is exactly the kind of thing Art. 15
      // is for.
      expect(bundle.data['sessions.user_id']).toHaveLength(1);
      expect(Object.keys(bundle.data['sessions.user_id'][0])).toContain('expires_at');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("contains none of another person's rows", () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000003', 'me3');
      const someoneElse = yield* createUser('900000000000000004', 'unrelated-person-zzz');
      yield* giveSession(me.id, 'mine');
      yield* giveSession(someoneElse.id, 'theirs');

      const bundle = yield* buildExport(me.id);
      const serialised = JSON.stringify(bundle);

      expect(serialised).not.toContain(someoneElse.id);
      // A distinctive needle: 'them' also matches "The events themselves are
      // exported" in an exclusion reason, which is a false positive rather
      // than a leak.
      expect(serialised).not.toContain('unrelated-person-zzz');
      expect(bundle.data['sessions.user_id']).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('reports what it withheld, so the gaps are visible to the person', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000005', 'me5');

      const bundle = yield* buildExport(me.id);

      expect(bundle.subjectUserId).toBe(me.id);
      expect(bundle.redactedColumns).toContain('sessions.token');
      expect(bundle.excluded.length).toBeGreaterThan(0);
      for (const entry of bundle.excluded) expect(entry.reason.length).toBeGreaterThan(40);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('covers every exported relationship, even with no data', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000006', 'me6');

      const bundle = yield* buildExport(me.id);

      // An empty array is a claim ("nothing here"); a missing key is silence.
      // Art. 15 wants the former.
      expect(Object.keys(bundle.data)).toContain('rules_attempts.user_id');
      expect(Object.keys(bundle.data)).toContain('event_rsvps.team_member_id');
    }).pipe(Effect.provide(TestLayer)),
  );

  // `check-rpc-encoding.mjs` guards `Rpc.make` contracts; it does not cover
  // `HttpApiEndpoint`, so the same nominal trap is unguarded on this route.
  // The handler constructs `Auth.DataExport` explicitly — this pins that it
  // must, and that a bundle straight from `buildExport` satisfies the wire
  // schema.
  it.effect('encodes against the endpoint schema the handler declares', () =>
    Effect.gen(function* () {
      const me = yield* createUser('900000000000000007', 'me7');
      const bundle = yield* buildExport(me.id);

      const encoded = yield* Schema.encodeUnknownEffect(Auth.DataExport)(
        new Auth.DataExport({ ...bundle }),
      );

      expect(encoded).toMatchObject({ subjectUserId: me.id });

      // The plain object is what a careless handler would return.
      const raw = yield* Effect.result(Schema.encodeUnknownEffect(Auth.DataExport)(bundle));
      expect(raw._tag, 'a plain object must not satisfy the class schema').toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );
});
