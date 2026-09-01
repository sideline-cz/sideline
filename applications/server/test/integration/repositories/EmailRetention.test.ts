// Retention purge, against a real database.
//
// This is the one job in the codebase whose whole purpose is to destroy data,
// so what matters is not that it deletes — it is that it deletes *only* what
// it should. Every test here is about a row that must survive.
//
// The failure that would matter is silent: purging a message still awaiting
// approval, or one inside the retention window, loses content nobody can
// recover and nobody would notice until someone went looking for it.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { RETENTION_DAYS } from '~/services/EmailRetentionCron.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EmailMessagesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

/** Via the repositories rather than raw SQL: `teams.created_by` is NOT NULL
 * and references `users`, so a bare insert cannot work. */
const makeTeam = Effect.gen(function* () {
  const users = yield* UsersRepository.asEffect();
  const teams = yield* TeamsRepository.asEffect();
  const user = yield* users.upsertFromDiscord({
    discord_id: '700000000000000001' as Discord.Snowflake,
    username: 'retention-fixture',
    avatar: Option.none(),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
  });
  const team = yield* teams.insert({
    name: 'Retention Test',
    guild_id: '700000000000000002' as Discord.Snowflake,
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

/** `ageDays` back-dates `received_at`, which is what the purge filters on. */
const insertEmail = (
  teamId: Team.TeamId,
  status: string,
  ageDays: number,
  body = 'the original message text',
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ id: string }>`
      INSERT INTO email_messages (team_id, status, from_address, subject, body, summary, received_at)
      VALUES (
        ${teamId}, ${status}, 'sender@example.com', 'Subject', ${body}, 'the posted summary',
        now() - make_interval(days => ${ageDays})
      )
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('email insert returned no row');
    yield* sql`
      INSERT INTO email_attachments (email_message_id, filename, content_type, size_bytes, content)
      VALUES (${id}, 'fixtures.pdf', 'application/pdf', 4, '\\x00010203'::bytea)
    `;
    return id;
  });

const readBack = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      body: string;
      summary: string | null;
      from_address: string;
      purged_at: Date | null;
    }>`SELECT body, summary, from_address, purged_at FROM email_messages WHERE id = ${id}::uuid`;
    const attachments = yield* sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM email_attachments WHERE email_message_id = ${id}::uuid`;
    return { row: rows[0], attachments: Number(attachments[0]?.count ?? '0') };
  });

const OLD = RETENTION_DAYS + 5;
const RECENT = RETENTION_DAYS - 5;

describe('email retention purge', () => {
  it.effect('empties the body and deletes attachments of an old, finished message', () =>
    Effect.gen(function* () {
      const team = yield* makeTeam;
      const id = yield* insertEmail(team, 'posted_summary', OLD);

      const purged = yield* EmailMessagesRepository.asEffect().pipe(
        Effect.andThen((r) => r.purgeOlderThan(RETENTION_DAYS)),
      );

      expect(purged).toBe(1);
      const { row, attachments } = yield* readBack(id);
      expect(row?.body).toBe('');
      expect(attachments).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('keeps the summary and the metadata — the record of what was posted', () =>
    Effect.gen(function* () {
      const team = yield* makeTeam;
      const id = yield* insertEmail(team, 'posted_original', OLD);

      yield* EmailMessagesRepository.asEffect().pipe(
        Effect.andThen((r) => r.purgeOlderThan(RETENTION_DAYS)),
      );

      const { row } = yield* readBack(id);
      expect(row?.summary).toBe('the posted summary');
      expect(row?.from_address).toBe('sender@example.com');
      expect(row?.purged_at).not.toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leaves messages inside the retention window completely alone', () =>
    Effect.gen(function* () {
      const team = yield* makeTeam;
      const id = yield* insertEmail(team, 'posted_summary', RECENT);

      const purged = yield* EmailMessagesRepository.asEffect().pipe(
        Effect.andThen((r) => r.purgeOlderThan(RETENTION_DAYS)),
      );

      expect(purged).toBe(0);
      const { row, attachments } = yield* readBack(id);
      expect(row?.body).toBe('the original message text');
      expect(attachments).toBe(1);
      expect(row?.purged_at).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // The one that matters most: work in flight is never destroyed, however old.
  for (const status of ['received', 'summarizing', 'pending_approval', 'approved', 'send_original'])
    it.effect(`never purges a '${status}' message, however old`, () =>
      Effect.gen(function* () {
        const team = yield* makeTeam;
        const id = yield* insertEmail(team, status, OLD * 10);

        const purged = yield* EmailMessagesRepository.asEffect().pipe(
          Effect.andThen((r) => r.purgeOlderThan(RETENTION_DAYS)),
        );

        expect(purged).toBe(0);
        const { row, attachments } = yield* readBack(id);
        expect(row?.body).toBe('the original message text');
        expect(attachments).toBe(1);
      }).pipe(Effect.provide(TestLayer)),
    );

  it.effect('is idempotent — a second run purges nothing', () =>
    Effect.gen(function* () {
      const team = yield* makeTeam;
      yield* insertEmail(team, 'rejected', OLD);
      const repo = yield* EmailMessagesRepository.asEffect();

      expect(yield* repo.purgeOlderThan(RETENTION_DAYS)).toBe(1);
      expect(yield* repo.purgeOlderThan(RETENTION_DAYS)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('purges every terminal status', () =>
    Effect.gen(function* () {
      const team = yield* makeTeam;
      for (const status of ['posted_summary', 'posted_original', 'rejected', 'failed'])
        yield* insertEmail(team, status, OLD);

      const purged = yield* EmailMessagesRepository.asEffect().pipe(
        Effect.andThen((r) => r.purgeOlderThan(RETENTION_DAYS)),
      );

      expect(purged).toBe(4);
    }).pipe(Effect.provide(TestLayer)),
  );

  it('states the same retention the privacy policy does', () => {
    // The published policy quotes a number. If this changes, that page has to
    // change with it — they are one commitment, not two.
    expect(RETENTION_DAYS).toBe(90);
  });
});
