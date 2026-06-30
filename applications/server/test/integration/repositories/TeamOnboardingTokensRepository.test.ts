// TDD mode — tests written BEFORE TeamOnboardingTokensRepository exists.
// These tests WILL FAIL until:
//   - applications/server/src/repositories/TeamOnboardingTokensRepository.ts is implemented
//   - The team_onboarding_tokens migration has been run against the test database

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { TeamOnboardingTokensRepository } from '~/repositories/TeamOnboardingTokensRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamOnboardingTokensRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
        guild_id: guildId,
        created_by: createdBy,
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
      }),
    ),
  );

const createToken = (
  createdBy: User.UserId,
  overrides?: {
    tokenHash?: string;
    proposedName?: string;
    boundDiscordId?: string;
    expiresAt?: DateTime.Utc;
  },
) =>
  TeamOnboardingTokensRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.create({
        token_hash: overrides?.tokenHash ?? 'abc123hashvalue',
        proposed_name: overrides?.proposedName ?? 'My Team',
        bound_discord_id:
          (overrides?.boundDiscordId as Discord.Snowflake) ??
          ('777000000000000001' as Discord.Snowflake),
        created_by: createdBy,
        expires_at:
          overrides?.expiresAt ??
          DateTime.fromDateUnsafe(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamOnboardingTokensRepository — create + findByHash', () => {
  it.effect('create then findByHash returns the row with all fields round-tripped', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('700000000000000001', 'admin-alice')),
      Effect.bind('expiresAt', () =>
        Effect.sync(() => DateTime.fromDateUnsafe(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))),
      ),
      Effect.bind('token', ({ user, expiresAt }) =>
        createToken(user.id, {
          tokenHash: 'sha256hexhashvalue0001',
          proposedName: 'Awesome Team',
          boundDiscordId: '700000000000000002',
          expiresAt,
        }),
      ),
      Effect.bind('found', () =>
        TeamOnboardingTokensRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByHash('sha256hexhashvalue0001')),
        ),
      ),
      Effect.tap(({ token, found, expiresAt }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);

          expect(row.id).toBe(token.id);
          expect(row.token_hash).toBe('sha256hexhashvalue0001');
          expect(row.proposed_name).toBe('Awesome Team');
          expect(row.bound_discord_id).toBe('700000000000000002');
          expect(Option.isNone(row.consumed_at)).toBe(true);
          expect(Option.isNone(row.consumed_by)).toBe(true);
          expect(Option.isNone(row.resulting_team_id)).toBe(true);
          expect(Option.isNone(row.revoked_at)).toBe(true);
          // expires_at should round-trip within ±5s
          const actualExpiresMs = DateTime.toEpochMillis(row.expires_at);
          const expectedExpiresMs = DateTime.toEpochMillis(expiresAt);
          expect(Math.abs(actualExpiresMs - expectedExpiresMs)).toBeLessThan(5000);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByHash returns None for unknown hash', () =>
    TeamOnboardingTokensRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findByHash('nonexistent-hash-xyz')),
      Effect.tap((found) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('TeamOnboardingTokensRepository — markConsumed', () => {
  it.effect(
    'markConsumed sets consumed_at, consumed_by, resulting_team_id — verify UPDATE and re-fetch',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('710000000000000001', 'captain-bob')),
        Effect.bind('team', ({ user }) =>
          createTeam('710000000000000002' as Discord.Snowflake, user.id),
        ),
        Effect.bind('token', ({ user }) =>
          createToken(user.id, { tokenHash: 'mark-consumed-hash-001' }),
        ),
        Effect.bind('result', ({ token, user, team }) =>
          TeamOnboardingTokensRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.markConsumed(token.id, {
                consumed_by: user.id,
                resulting_team_id: team.id,
              }),
            ),
          ),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Option.isSome(result)).toBe(true);
          }),
        ),
        Effect.bind('refetched', ({ token }) =>
          TeamOnboardingTokensRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByHash('mark-consumed-hash-001')),
          ),
        ),
        Effect.tap(({ refetched, user, team }) =>
          Effect.sync(() => {
            expect(Option.isSome(refetched)).toBe(true);
            const row = Option.getOrThrow(refetched);
            expect(Option.isSome(row.consumed_at)).toBe(true);
            expect(Option.getOrThrow(row.consumed_by)).toBe(user.id);
            expect(Option.getOrThrow(row.resulting_team_id)).toBe(team.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('markConsumed twice: second call returns None (atomic single-use enforcement)', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('720000000000000001', 'captain-charlie')),
      Effect.bind('team', ({ user }) =>
        createTeam('720000000000000002' as Discord.Snowflake, user.id),
      ),
      Effect.bind('token', ({ user }) =>
        createToken(user.id, { tokenHash: 'double-consume-hash-001' }),
      ),
      Effect.tap(({ token, user, team }) =>
        TeamOnboardingTokensRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.markConsumed(token.id, {
              consumed_by: user.id,
              resulting_team_id: team.id,
            }),
          ),
        ),
      ),
      Effect.bind('secondResult', ({ token, user, team }) =>
        TeamOnboardingTokensRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.markConsumed(token.id, {
              consumed_by: user.id,
              resulting_team_id: team.id,
            }),
          ),
        ),
      ),
      Effect.tap(({ secondResult }) =>
        Effect.sync(() => {
          expect(Option.isNone(secondResult)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('markConsumed races: two concurrent calls — exactly one returns Some', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('730000000000000001', 'captain-dave')),
      Effect.bind('team', ({ user }) =>
        createTeam('730000000000000002' as Discord.Snowflake, user.id),
      ),
      Effect.bind('token', ({ user }) =>
        createToken(user.id, { tokenHash: 'race-consume-hash-001' }),
      ),
      Effect.bind('results', ({ token, user, team }) =>
        Effect.all(
          [
            TeamOnboardingTokensRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.markConsumed(token.id, {
                  consumed_by: user.id,
                  resulting_team_id: team.id,
                }),
              ),
              Effect.exit,
            ),
            TeamOnboardingTokensRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.markConsumed(token.id, {
                  consumed_by: user.id,
                  resulting_team_id: team.id,
                }),
              ),
              Effect.exit,
            ),
          ],
          { concurrency: 'unbounded' },
        ),
      ),
      Effect.tap(({ results }) =>
        Effect.sync(() => {
          const successes = results.filter(
            (exit) => Exit.isSuccess(exit) && Option.isSome(exit.value),
          );
          const nones = results.filter((exit) => Exit.isSuccess(exit) && Option.isNone(exit.value));
          // Exactly one call wins, exactly one sees None (or both succeed with one being None)
          expect(successes.length + nones.length).toBe(2);
          expect(successes.length).toBe(1);
          expect(nones.length).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('TeamOnboardingTokensRepository — revoke', () => {
  it.effect('revoke sets revoked_at when token is not already revoked or consumed', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('740000000000000001', 'admin-eve')),
      Effect.bind('token', ({ user }) =>
        createToken(user.id, { tokenHash: 'revoke-test-hash-001' }),
      ),
      Effect.tap(({ token }) =>
        TeamOnboardingTokensRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.revoke(token.id)),
        ),
      ),
      Effect.bind('found', () =>
        TeamOnboardingTokensRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByHash('revoke-test-hash-001')),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isSome(row.revoked_at)).toBe(true);
          expect(Option.isNone(row.consumed_at)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('TeamOnboardingTokensRepository — listForAdmin', () => {
  it.effect('listForAdmin orders by created_at DESC with stable id tiebreaker', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('750000000000000001', 'admin-frank')),
      Effect.tap(({ user }) =>
        createToken(user.id, {
          tokenHash: 'list-hash-first-001',
          proposedName: 'Team Alpha',
          boundDiscordId: '750000000000000002',
        }),
      ),
      Effect.tap(({ user }) =>
        createToken(user.id, {
          tokenHash: 'list-hash-second-001',
          proposedName: 'Team Beta',
          boundDiscordId: '750000000000000003',
        }),
      ),
      Effect.tap(({ user }) =>
        createToken(user.id, {
          tokenHash: 'list-hash-third-001',
          proposedName: 'Team Gamma',
          boundDiscordId: '750000000000000004',
        }),
      ),
      Effect.bind('list', () =>
        TeamOnboardingTokensRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.listForAdmin()),
        ),
      ),
      Effect.tap(({ list }) =>
        Effect.sync(() => {
          expect(list.length).toBeGreaterThanOrEqual(3);
          // Verify descending order by created_at
          for (let i = 0; i < list.length - 1; i++) {
            const current = DateTime.toEpochMillis(list[i].created_at);
            const next = DateTime.toEpochMillis(list[i + 1].created_at);
            // When timestamps are equal the tiebreaker (id DESC) kicks in —
            // both orderings are valid; we just assert non-ascending.
            expect(current).toBeGreaterThanOrEqual(next);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('TeamOnboardingTokensRepository — unique token_hash constraint', () => {
  it.effect('second create with same token_hash fails (catchSqlErrors maps to defect)', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('760000000000000001', 'admin-grace')),
      Effect.tap(({ user }) => createToken(user.id, { tokenHash: 'duplicate-hash-value-001' })),
      Effect.bind('exit', ({ user }) =>
        createToken(user.id, { tokenHash: 'duplicate-hash-value-001' }).pipe(Effect.exit),
      ),
      Effect.tap(({ exit }) =>
        Effect.sync(() => {
          // The unique violation is caught by catchSqlErrors and re-thrown as a defect
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
