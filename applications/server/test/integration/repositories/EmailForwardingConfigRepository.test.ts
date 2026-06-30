import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EmailForwardingConfigRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

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
    Effect.map((u) => u.id),
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

describe('EmailForwardingConfigRepository', () => {
  // Regression: row timestamps must decode from the JS Date the pg client
  // returns. A wrong schema (e.g. Schema.DateTimeUtc) makes this round-trip
  // throw a ParseError → HTTP 500 on save.
  it.effect('upsert then findByTeam round-trips and decodes timestamps', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000101', 'email-cfg-user-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('901010101010101010' as Discord.Snowflake, userId),
      ),
      Effect.tap(({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              team_id: team.id,
              enabled: true,
              target_channel_id: '111111111111111111',
              coach_channel_id: '222222222222222222',
              monitored_addresses: ['league@example.com'],
              imap_enabled: false,
              imap_host: Option.none(),
              imap_port: Option.none(),
              imap_username: Option.none(),
              imap_secret_encrypted: Option.none(),
              imap_use_tls: true,
              imap_folder: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeam(team.id)),
        ),
      ),
      Effect.tap(({ found, team }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const cfg = Option.getOrThrow(found);
          expect(cfg.team_id).toBe(team.id);
          expect(cfg.enabled).toBe(true);
          expect(cfg.target_channel_id).toBe('111111111111111111');
          expect(cfg.coach_channel_id).toBe('222222222222222222');
          expect(cfg.monitored_addresses).toEqual(['league@example.com']);
          expect(cfg.inbound_token.length).toBeGreaterThan(0);
          // The timestamps must decode into DateTime.Utc values.
          expect(DateTime.isDateTime(cfg.created_at)).toBe(true);
          expect(DateTime.isDateTime(cfg.updated_at)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('upsert on conflict updates fields and preserves the token', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000102', 'email-cfg-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('902020202020202020' as Discord.Snowflake, userId),
      ),
      Effect.bind('first', ({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              team_id: team.id,
              enabled: false,
              target_channel_id: '111111111111111111',
              coach_channel_id: '222222222222222222',
              monitored_addresses: [],
              imap_enabled: false,
              imap_host: Option.none(),
              imap_port: Option.none(),
              imap_username: Option.none(),
              imap_secret_encrypted: Option.none(),
              imap_use_tls: true,
              imap_folder: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('second', ({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              team_id: team.id,
              enabled: true,
              target_channel_id: '333333333333333333',
              coach_channel_id: '444444444444444444',
              monitored_addresses: ['a@example.com'],
              imap_enabled: false,
              imap_host: Option.none(),
              imap_port: Option.none(),
              imap_username: Option.none(),
              imap_secret_encrypted: Option.none(),
              imap_use_tls: true,
              imap_folder: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ first, second }) =>
        Effect.sync(() => {
          expect(second.enabled).toBe(true);
          expect(second.target_channel_id).toBe('333333333333333333');
          expect(second.monitored_addresses).toEqual(['a@example.com']);
          // Token is minted on insert and not changed by a plain upsert.
          expect(second.inbound_token).toBe(first.inbound_token);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('regenerateToken rotates the token and findByInboundToken resolves it', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000103', 'email-cfg-user-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('903030303030303030' as Discord.Snowflake, userId),
      ),
      Effect.bind('initial', ({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              team_id: team.id,
              enabled: true,
              target_channel_id: '111111111111111111',
              coach_channel_id: '222222222222222222',
              monitored_addresses: [],
              imap_enabled: false,
              imap_host: Option.none(),
              imap_port: Option.none(),
              imap_username: Option.none(),
              imap_secret_encrypted: Option.none(),
              imap_use_tls: true,
              imap_folder: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('regenerated', ({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.regenerateToken(team.id)),
        ),
      ),
      Effect.bind('byToken', ({ regenerated }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByInboundToken(regenerated.inbound_token)),
        ),
      ),
      Effect.tap(({ initial, regenerated, byToken, team }) =>
        Effect.sync(() => {
          expect(regenerated.inbound_token).not.toBe(initial.inbound_token);
          expect(Option.isSome(byToken)).toBe(true);
          expect(Option.getOrThrow(byToken).team_id).toBe(team.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
