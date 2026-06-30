/**
 * Integration tests for IMAP-specific EmailForwardingConfigRepository methods.
 *
 * Covers:
 * 1. upsert stores imap fields incl. imap_secret_encrypted; findByTeam returns them verbatim
 * 2. omitted secret (None) on re-upsert preserves the existing encrypted secret
 * 3. updateImapSync stores lastSeenUid, uidValidity, imap_last_synced_at
 * 4. findImapEnabled returns only rows with imap_enabled AND enabled AND secret IS NOT NULL
 */
import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const TestLayer = Layer.mergeAll(
  EmailForwardingConfigRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers to create a team and user
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
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'IMAP Test Team',
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

// ---------------------------------------------------------------------------
// Test 1: upsert stores imap fields; findByTeam returns them verbatim
// ---------------------------------------------------------------------------

describe('EmailForwardingConfigRepository IMAP — upsert stores imap fields', () => {
  it.effect(
    'upsert with all imap fields → findByTeam returns them verbatim (repo does NOT encrypt)',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('980000000000000001', 'imap-test-user-1')),
        Effect.bind('team', ({ userId }) =>
          createTeam('981010101010101010' as Discord.Snowflake, userId),
        ),
        Effect.tap(({ team }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert({
                team_id: team.id,
                enabled: true,
                target_channel_id: '111111111111111111',
                coach_channel_id: '222222222222222222',
                monitored_addresses: [],
                imap_enabled: true,
                imap_host: Option.some('imap.example.com'),
                imap_port: Option.some(993),
                imap_username: Option.some('user@example.com'),
                imap_secret_encrypted: Option.some('enc-blob'),
                imap_use_tls: true,
                imap_folder: Option.some('INBOX'),
              }),
            ),
          ),
        ),
        Effect.bind('found', ({ team }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByTeam(team.id)),
          ),
        ),
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            expect(Option.isSome(found)).toBe(true);
            const cfg = Option.getOrThrow(found);
            expect(cfg.imap_enabled).toBe(true);
            expect(Option.getOrThrow(cfg.imap_host)).toBe('imap.example.com');
            expect(Option.getOrThrow(cfg.imap_port)).toBe(993);
            expect(Option.getOrThrow(cfg.imap_username)).toBe('user@example.com');
            // Repo stores exactly what it was given — no encryption/transformation
            expect(Option.getOrThrow(cfg.imap_secret_encrypted)).toBe('enc-blob');
            expect(cfg.imap_use_tls).toBe(true);
            expect(Option.getOrThrow(cfg.imap_folder)).toBe('INBOX');
            expect(cfg.imap_last_seen_uid).toBe(0);
            expect(Option.isNone(cfg.imap_uid_validity)).toBe(true);
            expect(Option.isNone(cfg.imap_last_synced_at)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Test 2: omitted secret preserved on re-upsert
// ---------------------------------------------------------------------------

describe('EmailForwardingConfigRepository IMAP — omitted secret preserved on re-upsert', () => {
  it.effect('upsert with secret=None on second call preserves the existing encrypted secret', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('980000000000000002', 'imap-test-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('982020202020202020' as Discord.Snowflake, userId),
      ),
      // First upsert — sets the secret
      Effect.tap(({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              team_id: team.id,
              enabled: true,
              target_channel_id: '111111111111111111',
              coach_channel_id: '222222222222222222',
              monitored_addresses: [],
              imap_enabled: true,
              imap_host: Option.some('imap.example.com'),
              imap_port: Option.some(993),
              imap_username: Option.some('user@example.com'),
              imap_secret_encrypted: Option.some('blob1'), // set secret
              imap_use_tls: true,
              imap_folder: Option.some('INBOX'),
            }),
          ),
        ),
      ),
      // Second upsert — secret=None (keep existing)
      Effect.tap(({ team }) =>
        EmailForwardingConfigRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              team_id: team.id,
              enabled: false, // changed
              target_channel_id: '333333333333333333', // changed
              coach_channel_id: '444444444444444444', // changed
              monitored_addresses: ['new@example.com'],
              imap_enabled: false, // changed
              imap_host: Option.some('imap2.example.com'),
              imap_port: Option.some(143),
              imap_username: Option.some('user2@example.com'),
              imap_secret_encrypted: Option.none(), // omit → preserve
              imap_use_tls: false,
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
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const cfg = Option.getOrThrow(found);
          // Other fields were updated
          expect(cfg.enabled).toBe(false);
          expect(cfg.target_channel_id).toBe('333333333333333333');
          // Secret was preserved from the first upsert
          expect(Option.getOrThrow(cfg.imap_secret_encrypted)).toBe('blob1');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Test 3: updateImapSync persists uid, validity, synced_at
// ---------------------------------------------------------------------------

describe('EmailForwardingConfigRepository IMAP — updateImapSync', () => {
  it.effect(
    'updateImapSync stores imap_last_seen_uid, imap_uid_validity, imap_last_synced_at',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('980000000000000003', 'imap-test-user-3')),
        Effect.bind('team', ({ userId }) =>
          createTeam('983030303030303030' as Discord.Snowflake, userId),
        ),
        // Create the config row first
        Effect.tap(({ team }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert({
                team_id: team.id,
                enabled: true,
                target_channel_id: '111111111111111111',
                coach_channel_id: '222222222222222222',
                monitored_addresses: [],
                imap_enabled: true,
                imap_host: Option.some('imap.example.com'),
                imap_port: Option.some(993),
                imap_username: Option.some('user@example.com'),
                imap_secret_encrypted: Option.some('enc'),
                imap_use_tls: true,
                imap_folder: Option.some('INBOX'),
              }),
            ),
          ),
        ),
        // Call updateImapSync
        Effect.bind('syncedAt', () =>
          Effect.sync(() => DateTime.makeUnsafe('2024-06-01T12:00:00Z')),
        ),
        Effect.tap(({ team, syncedAt }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.updateImapSync(team.id, 42, 7, syncedAt)),
          ),
        ),
        Effect.bind('found', ({ team }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByTeam(team.id)),
          ),
        ),
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            expect(Option.isSome(found)).toBe(true);
            const cfg = Option.getOrThrow(found);
            expect(cfg.imap_last_seen_uid).toBe(42);
            expect(Option.getOrThrow(cfg.imap_uid_validity)).toBe(7);
            expect(Option.isSome(cfg.imap_last_synced_at)).toBe(true);
            // Timestamp is a DateTime — just assert it's present
            expect(DateTime.isDateTime(Option.getOrThrow(cfg.imap_last_synced_at))).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Test 4: findImapEnabled returns only rows matching the filter
// ---------------------------------------------------------------------------

describe('EmailForwardingConfigRepository IMAP — findImapEnabled filter', () => {
  it.effect(
    'findImapEnabled returns only rows with imap_enabled AND enabled AND secret NOT NULL',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('980000000000000004', 'imap-test-user-4')),
        Effect.bind('teamEnabled', ({ userId }) =>
          createTeam('984040404040404040' as Discord.Snowflake, userId),
        ),
        Effect.bind('teamDisabled', ({ userId }) =>
          createTeam('984040404040404041' as Discord.Snowflake, userId),
        ),
        Effect.bind('teamImapDisabled', ({ userId }) =>
          createTeam('984040404040404042' as Discord.Snowflake, userId),
        ),
        Effect.bind('teamNoSecret', ({ userId }) =>
          createTeam('984040404040404043' as Discord.Snowflake, userId),
        ),
        // Row 1: enabled=true, imap_enabled=true, secret=Some → SHOULD be returned
        Effect.tap(({ teamEnabled }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert({
                team_id: teamEnabled.id,
                enabled: true,
                target_channel_id: '111111111111111111',
                coach_channel_id: '222222222222222222',
                monitored_addresses: [],
                imap_enabled: true,
                imap_host: Option.some('imap.example.com'),
                imap_port: Option.some(993),
                imap_username: Option.some('u@example.com'),
                imap_secret_encrypted: Option.some('enc-secret'),
                imap_use_tls: true,
                imap_folder: Option.some('INBOX'),
              }),
            ),
          ),
        ),
        // Row 2: enabled=false → should NOT be returned
        Effect.tap(({ teamDisabled }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert({
                team_id: teamDisabled.id,
                enabled: false,
                target_channel_id: '111111111111111111',
                coach_channel_id: '222222222222222222',
                monitored_addresses: [],
                imap_enabled: true,
                imap_host: Option.some('imap.example.com'),
                imap_port: Option.some(993),
                imap_username: Option.some('u@example.com'),
                imap_secret_encrypted: Option.some('enc-secret'),
                imap_use_tls: true,
                imap_folder: Option.some('INBOX'),
              }),
            ),
          ),
        ),
        // Row 3: imap_enabled=false → should NOT be returned
        Effect.tap(({ teamImapDisabled }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert({
                team_id: teamImapDisabled.id,
                enabled: true,
                target_channel_id: '111111111111111111',
                coach_channel_id: '222222222222222222',
                monitored_addresses: [],
                imap_enabled: false,
                imap_host: Option.some('imap.example.com'),
                imap_port: Option.some(993),
                imap_username: Option.some('u@example.com'),
                imap_secret_encrypted: Option.some('enc-secret'),
                imap_use_tls: true,
                imap_folder: Option.some('INBOX'),
              }),
            ),
          ),
        ),
        // Row 4: imap_secret_encrypted=None → should NOT be returned
        Effect.tap(({ teamNoSecret }) =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert({
                team_id: teamNoSecret.id,
                enabled: true,
                target_channel_id: '111111111111111111',
                coach_channel_id: '222222222222222222',
                monitored_addresses: [],
                imap_enabled: true,
                imap_host: Option.some('imap.example.com'),
                imap_port: Option.some(993),
                imap_username: Option.some('u@example.com'),
                imap_secret_encrypted: Option.none(), // no secret
                imap_use_tls: true,
                imap_folder: Option.some('INBOX'),
              }),
            ),
          ),
        ),
        // Now query
        Effect.bind('imapEnabled', () =>
          EmailForwardingConfigRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findImapEnabled()),
          ),
        ),
        Effect.tap(({ imapEnabled, teamEnabled, teamDisabled, teamImapDisabled, teamNoSecret }) =>
          Effect.sync(() => {
            // Only teamEnabled should be in the result
            const rows = imapEnabled as ReadonlyArray<{ team_id: string }>;
            const ids = rows.map((r) => r.team_id);
            expect(ids).toContain(teamEnabled.id);
            expect(ids).not.toContain(teamDisabled.id);
            expect(ids).not.toContain(teamImapDisabled.id);
            expect(ids).not.toContain(teamNoSecret.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
