import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EmailMessagesRepository.Default,
  EmailForwardingConfigRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers to seed prerequisite rows
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
        name: 'Email Test Team',
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
        overview_channel_id: Option.none(),
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
// Tests
// ---------------------------------------------------------------------------

describe('EmailMessagesRepository', () => {
  it.effect('sendOriginal on pending → returns Some + status=send_original', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000001', 'msg-repo-user-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('911111111111111111' as Discord.Snowflake, userId),
      ),
      Effect.bind('emailId', ({ team }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertReceived({
              team_id: team.id,
              from_address: 'league@example.com',
              subject: 'Pending Email',
              body: 'Body text',
              received_at: DateTime.makeUnsafe('2024-06-01T10:00:00Z'),
            }),
          ),
        ),
      ),
      // Claim the email and move it to pending_approval
      Effect.tap(({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .claimForSummarizing(emailId)
              .pipe(Effect.andThen(() => repo.setSummaryPendingApproval(emailId, 'AI summary'))),
          ),
        ),
      ),
      // Call sendOriginal
      Effect.bind('result', ({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.sendOriginal(emailId, 'coach-user-id')),
        ),
      ),
      // Verify result is Some
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
        }),
      ),
      // Reload and verify status
      Effect.bind('row', ({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(emailId))),
      ),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(Option.isSome(row)).toBe(true);
          const r = Option.getOrThrow(row);
          expect(r.status).toBe('send_original');
          expect(Option.isSome(r.approved_by)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('sendOriginal on non-pending → returns None (no state change)', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000002', 'msg-repo-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('912222222222222222' as Discord.Snowflake, userId),
      ),
      Effect.bind('emailId', ({ team }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertReceived({
              team_id: team.id,
              from_address: 'league@example.com',
              subject: 'Received Email',
              body: 'Body text',
              received_at: DateTime.makeUnsafe('2024-06-01T10:00:00Z'),
            }),
          ),
        ),
      ),
      // Do NOT move to pending_approval — call sendOriginal on 'received' status
      Effect.bind('result', ({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.sendOriginal(emailId, 'coach-user-id')),
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(Option.isNone(result)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('dismiss on pending → returns Some + status=rejected', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000003', 'msg-repo-user-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('913333333333333333' as Discord.Snowflake, userId),
      ),
      Effect.bind('emailId', ({ team }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertReceived({
              team_id: team.id,
              from_address: 'league@example.com',
              subject: 'Pending Email',
              body: 'Body text',
              received_at: DateTime.makeUnsafe('2024-06-01T10:00:00Z'),
            }),
          ),
        ),
      ),
      // Move to pending_approval
      Effect.tap(({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .claimForSummarizing(emailId)
              .pipe(Effect.andThen(() => repo.setSummaryPendingApproval(emailId, 'AI summary'))),
          ),
        ),
      ),
      // Call dismiss
      Effect.bind('result', ({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.dismiss(emailId, 'coach-user-id')),
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
        }),
      ),
      // Reload and verify
      Effect.bind('row', ({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(emailId))),
      ),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(Option.isSome(row)).toBe(true);
          const r = Option.getOrThrow(row);
          expect(r.status).toBe('rejected');
          expect(Option.isSome(r.rejected_by)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('setPosted after sendOriginal → status=posted_original, posted_channel_id set', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000004', 'msg-repo-user-4')),
      Effect.bind('team', ({ userId }) =>
        createTeam('914444444444444444' as Discord.Snowflake, userId),
      ),
      Effect.bind('emailId', ({ team }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertReceived({
              team_id: team.id,
              from_address: 'league@example.com',
              subject: 'Pending Email',
              body: 'Body text',
              received_at: DateTime.makeUnsafe('2024-06-01T10:00:00Z'),
            }),
          ),
        ),
      ),
      // Move to pending_approval
      Effect.tap(({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .claimForSummarizing(emailId)
              .pipe(Effect.andThen(() => repo.setSummaryPendingApproval(emailId, 'AI summary'))),
          ),
        ),
      ),
      // sendOriginal → send_original status
      Effect.tap(({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.sendOriginal(emailId, 'coach-user-id')),
        ),
      ),
      // setPosted with posted_original
      Effect.tap(({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.setPosted(emailId, 'posted_original', '555555555555555555'),
          ),
        ),
      ),
      // Reload and verify
      Effect.bind('row', ({ emailId }) =>
        EmailMessagesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(emailId))),
      ),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(Option.isSome(row)).toBe(true);
          const r = Option.getOrThrow(row);
          expect(r.status).toBe('posted_original');
          expect(Option.isSome(r.posted_channel_id)).toBe(true);
          expect(Option.getOrThrow(r.posted_channel_id)).toBe('555555555555555555');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
