import { describe, expect, it } from '@effect/vitest';
import type { User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = UsersRepository.Default.pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

describe('UsersRepository', () => {
  it.effect('upsertFromDiscord creates a new user', () =>
    Effect.Do.pipe(
      Effect.bind('user', () =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '123456789012345678',
              username: 'testuser',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ user }) =>
        Effect.sync(() => {
          expect(user.discord_id).toBe('123456789012345678');
          expect(user.username).toBe('testuser');
          expect(Option.isNone(user.avatar)).toBe(true);
          expect(user.is_profile_complete).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('upsertFromDiscord updates existing user on conflict', () =>
    Effect.Do.pipe(
      Effect.tap(() =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '999999999999999999',
              username: 'original',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('updated', () =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '999999999999999999',
              username: 'updated',
              avatar: Option.some('avatar-hash'),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ updated }) =>
        Effect.sync(() => {
          expect(updated.discord_id).toBe('999999999999999999');
          expect(updated.username).toBe('updated');
          expect(Option.getOrNull(updated.avatar)).toBe('avatar-hash');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findById returns Some for existing user', () =>
    Effect.Do.pipe(
      Effect.bind('created', () =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '111111111111111111',
              username: 'findme',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ created }) =>
        UsersRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(created.id))),
      ),
      Effect.tap(({ created, found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const user = Option.getOrThrow(found);
          expect(user.id).toBe(created.id);
          expect(user.username).toBe('findme');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findById returns None for non-existent user', () =>
    UsersRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.findById('00000000-0000-0000-0000-000000000099' as User.UserId),
      ),
      Effect.tap((found) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByDiscordId returns Some for existing user', () =>
    Effect.Do.pipe(
      Effect.tap(() =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '222222222222222222',
              username: 'discorduser',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('found', () =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByDiscordId('222222222222222222')),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const user = Option.getOrThrow(found);
          expect(user.discord_id).toBe('222222222222222222');
          expect(user.username).toBe('discorduser');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByDiscordId returns None for non-existent discord id', () =>
    UsersRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findByDiscordId('000000000000000000')),
      Effect.tap((found) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('completeProfile updates profile fields and sets is_profile_complete to true', () =>
    Effect.Do.pipe(
      Effect.bind('created', () =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '333333333333333333',
              username: 'profileuser',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('completed', ({ created }) =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.completeProfile({
              id: created.id,
              name: Option.some('John Doe'),
              birth_date: Option.some(DateTime.makeUnsafe(new Date('1990-01-15'))),
              gender: Option.some('male' as User.Gender),
            }),
          ),
        ),
      ),
      Effect.tap(({ completed }) =>
        Effect.sync(() => {
          expect(completed.is_profile_complete).toBe(true);
          expect(Option.getOrNull(completed.name)).toBe('John Doe');
          expect(Option.getOrNull(completed.gender)).toBe('male');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('updateLocale changes user locale', () =>
    Effect.Do.pipe(
      Effect.bind('created', () =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '444444444444444444',
              username: 'localeuser',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('updated', ({ created }) =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.updateLocale({
              id: created.id,
              locale: 'cs',
            }),
          ),
        ),
      ),
      Effect.tap(({ updated }) =>
        Effect.sync(() => {
          expect(updated.locale).toBe('cs');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // ---------------------------------------------------------------------------
  // TDD: first registered user = global admin
  // ---------------------------------------------------------------------------

  it.effect('first user gets is_global_admin = true', () =>
    Effect.gen(function* () {
      const repo = yield* UsersRepository.asEffect();
      const user = yield* repo.upsertFromDiscord({
        discord_id: '555000000000000001',
        username: 'firstuser',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });
      expect(user.is_global_admin).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('second user gets is_global_admin = false', () =>
    Effect.gen(function* () {
      const repo = yield* UsersRepository.asEffect();

      // Insert first user (should become global admin)
      const userA = yield* repo.upsertFromDiscord({
        discord_id: '555000000000000002',
        username: 'usera',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });

      // Insert second user (should NOT be global admin)
      const userB = yield* repo.upsertFromDiscord({
        discord_id: '555000000000000003',
        username: 'userb',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });

      // Read back user A to confirm their flag was preserved
      const foundA = yield* repo.findById(userA.id);
      const readA = Option.getOrThrow(foundA);

      expect(readA.is_global_admin).toBe(true);
      expect(userB.is_global_admin).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('re-login of first user keeps is_global_admin = true and updates username', () =>
    Effect.gen(function* () {
      const repo = yield* UsersRepository.asEffect();

      // Insert user A for the first time
      yield* repo.upsertFromDiscord({
        discord_id: '555000000000000004',
        username: 'original-name',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });

      // Re-login of user A with a changed username (ON CONFLICT path)
      const reLoggedIn = yield* repo.upsertFromDiscord({
        discord_id: '555000000000000004',
        username: 'updated-name',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });

      expect(reLoggedIn.is_global_admin).toBe(true);
      expect(reLoggedIn.username).toBe('updated-name');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('re-login of second user keeps is_global_admin = false', () =>
    Effect.gen(function* () {
      const repo = yield* UsersRepository.asEffect();

      // User A registers first
      yield* repo.upsertFromDiscord({
        discord_id: '555000000000000005',
        username: 'usera-second-test',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });

      // User B registers second
      yield* repo.upsertFromDiscord({
        discord_id: '555000000000000006',
        username: 'userb-second-test',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });

      // User B re-logs in with updated username
      const userBReLogin = yield* repo.upsertFromDiscord({
        discord_id: '555000000000000006',
        username: 'userb-second-test-updated',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      });

      expect(userBReLogin.is_global_admin).toBe(false);
      expect(userBReLogin.username).toBe('userb-second-test-updated');
    }).pipe(Effect.provide(TestLayer)),
  );
});
