// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require:
//   - Migration 1790100003: CREATE TABLE personal_event_messages
//   - Migration 1790100004: ALTER TABLE events ADD COLUMN personal_messages_dirty_at TIMESTAMPTZ
//   - A new PersonalEventMessagesRepository service with methods:
//       upsertPersonalEventMessage(eventId, teamMemberId, personalChannelId, discordMessageId, payloadHash)
//       getPersonalEventMessage(eventId, teamMemberId) → Option<row>
//       getEventsNeedingReconcile(limit) → ReadonlyArray<{event_id, team_id, guild_id, ...}>
// These tests WILL FAIL until the developer implements the repository and migrations.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
// TDD: implement PersonalEventMessagesRepository
import { PersonalEventMessagesRepository } from '~/repositories/PersonalEventMessagesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  // TDD: implement PersonalEventMessagesRepository.Default
  PersonalEventMessagesRepository.Default,
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

const seedTeamWithMember = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, member })),
  );

const createEvent = (teamId: Team.TeamId, createdBy: string, startAtIso: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Test Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date(startAtIso)),
        endAt: Option.none(),
        location: Option.none(),
        trainingTypeId: Option.none(),
        createdBy: createdBy as any,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests: upsert by (event_id, team_member_id)
// ---------------------------------------------------------------------------

describe('PersonalEventMessagesRepository — upsertPersonalEventMessage', () => {
  it.effect('insert then update on same (event_id, team_member_id) updates the same row', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '420000000000000001',
          'pem-upsert-1',
          '421010101010101010' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.member.id, '2027-01-15T14:00:00Z'),
      ),
      // First upsert (INSERT)
      Effect.tap(({ event, seed }) =>
        PersonalEventMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // TDD: implement upsertPersonalEventMessage
            repo.upsertPersonalEventMessage(
              event.id,
              seed.member.id,
              '421100000000000001' as Discord.Snowflake, // personalChannelId
              '421200000000000001' as Discord.Snowflake, // discordMessageId
              'hash-v1',
            ),
          ),
        ),
      ),
      // Second upsert (UPDATE) — same event+member, different hash and message id
      Effect.tap(({ event, seed }) =>
        PersonalEventMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertPersonalEventMessage(
              event.id,
              seed.member.id,
              '421100000000000001' as Discord.Snowflake,
              '421200000000000002' as Discord.Snowflake, // updated message id
              'hash-v2',
            ),
          ),
        ),
      ),
      // Verify only one row exists
      Effect.bind('count', ({ event, seed }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe<{ count: string }>(`
            SELECT COUNT(*)::text AS count FROM personal_event_messages
            WHERE event_id = '${event.id}' AND team_member_id = '${seed.member.id}'
          `),
          ),
          Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
        ),
      ),
      Effect.bind('row', ({ event, seed }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe<{ discord_message_id: string; payload_hash: string }>(`
            SELECT discord_message_id, payload_hash FROM personal_event_messages
            WHERE event_id = '${event.id}' AND team_member_id = '${seed.member.id}'
          `),
          ),
          Effect.map((rows) => rows[0]),
        ),
      ),
      Effect.tap(({ count, row }) =>
        Effect.sync(() => {
          // Must be exactly one row (upsert, not duplicate)
          expect(count).toBe(1);
          // Updated values must be persisted
          expect(row?.discord_message_id).toBe('421200000000000002');
          expect(row?.payload_hash).toBe('hash-v2');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('getPersonalEventMessage returns Some after upsert', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '422000000000000001',
          'pem-get-1',
          '423010101010101010' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        createEvent(seed.team.id, seed.member.id, '2027-01-20T14:00:00Z'),
      ),
      Effect.tap(({ event, seed }) =>
        PersonalEventMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertPersonalEventMessage(
              event.id,
              seed.member.id,
              '423100000000000001' as Discord.Snowflake,
              '423200000000000001' as Discord.Snowflake,
              'hash-abc',
            ),
          ),
        ),
      ),
      Effect.bind('msg', ({ event, seed }) =>
        PersonalEventMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // TDD: implement getPersonalEventMessage(eventId, memberId) → Option<row>
            repo.getPersonalEventMessage(event.id, seed.member.id),
          ),
        ),
      ),
      Effect.tap(({ msg }) =>
        Effect.sync(() => {
          expect(Option.isSome(msg)).toBe(true);
          const row = Option.getOrThrow(msg);
          expect(row.payload_hash).toBe('hash-abc');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: FK cascade when event is deleted
// ---------------------------------------------------------------------------

describe('PersonalEventMessagesRepository — FK cascade on event delete', () => {
  it.effect(
    'deleting the event cascades and removes all personal_event_messages rows for that event',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '424000000000000001',
            'fk-cascade-1',
            '424040404040404040' as Discord.Snowflake,
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.member.id, '2027-02-01T14:00:00Z'),
        ),
        Effect.tap(({ event, seed }) =>
          PersonalEventMessagesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsertPersonalEventMessage(
                event.id,
                seed.member.id,
                '424100000000000001' as Discord.Snowflake,
                '424200000000000001' as Discord.Snowflake,
                'hash-cascade',
              ),
            ),
          ),
        ),
        // Delete the event — should cascade to personal_event_messages
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) => sql.unsafe(`DELETE FROM events WHERE id = '${event.id}'`)),
          ),
        ),
        Effect.bind('count', ({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe<{ count: string }>(`
              SELECT COUNT(*)::text AS count FROM personal_event_messages
              WHERE event_id = '${event.id}'
            `),
            ),
            Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
          ),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Tests: getEventsNeedingReconcile
// ---------------------------------------------------------------------------

describe('PersonalEventMessagesRepository — getEventsNeedingReconcile', () => {
  it.effect(
    'returns events with personal_messages_dirty_at set; excludes events with NULL dirty_at',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '425000000000000001',
            'reconcile-1',
            '425050505050505050' as Discord.Snowflake,
          ),
        ),
        Effect.bind('dirtyEvent', ({ seed }) =>
          createEvent(seed.team.id, seed.member.id, '2027-03-01T14:00:00Z'),
        ),
        Effect.bind('cleanEvent', ({ seed }) =>
          createEvent(seed.team.id, seed.member.id, '2027-03-02T14:00:00Z'),
        ),
        // Set personal_messages_dirty_at on dirtyEvent only
        Effect.tap(({ dirtyEvent }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(
                `UPDATE events SET personal_messages_dirty_at = now() WHERE id = '${dirtyEvent.id}'`,
              ),
            ),
          ),
        ),
        Effect.bind('results', () =>
          PersonalEventMessagesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              // TDD: implement getEventsNeedingReconcile(limit) → array of events
              repo.getEventsNeedingReconcile(100),
            ),
          ),
        ),
        Effect.tap(({ results, dirtyEvent, cleanEvent }) =>
          Effect.sync(() => {
            expect(results.map((r) => r.event_id)).toContain(dirtyEvent.id);
            expect(results.map((r) => r.event_id)).not.toContain(cleanEvent.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('limit is honoured — returns at most N events', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '426000000000000001',
          'reconcile-limit-1',
          '426060606060606060' as Discord.Snowflake,
        ),
      ),
      // Create 3 dirty events
      Effect.bind('events', ({ seed }) =>
        Effect.all([
          createEvent(seed.team.id, seed.member.id, '2027-04-01T14:00:00Z'),
          createEvent(seed.team.id, seed.member.id, '2027-04-02T14:00:00Z'),
          createEvent(seed.team.id, seed.member.id, '2027-04-03T14:00:00Z'),
        ]),
      ),
      Effect.tap(({ events }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(
              `UPDATE events SET personal_messages_dirty_at = now() WHERE id IN (${events.map((e) => `'${e.id}'`).join(',')})`,
            ),
          ),
        ),
      ),
      Effect.bind('results', () =>
        PersonalEventMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getEventsNeedingReconcile(2)),
        ),
      ),
      Effect.tap(({ results }) =>
        Effect.sync(() => {
          expect(results.length).toBeLessThanOrEqual(2);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'dirty → read dirty_at → clear with exact value → marker is NULL (lossless round-trip)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '427000000000000001',
            'reconcile-clear-1',
            '427070707070707070' as Discord.Snowflake,
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          createEvent(seed.team.id, seed.member.id, '2027-05-01T14:00:00Z'),
        ),
        // Dirty via the repository method (uses date_trunc('milliseconds', now()))
        Effect.tap(({ event }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.markEventPersonalMessagesDirty(event.id)),
          ),
        ),
        // Read the dirty_at back through getEventsNeedingReconcile
        Effect.bind('row', ({ event }) =>
          PersonalEventMessagesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getEventsNeedingReconcile(100)),
            Effect.map((rows) => rows.find((r) => r.event_id === event.id)),
          ),
        ),
        // Clear using the exact dirty_at observed
        Effect.tap(({ row, event }) => {
          expect(row).toBeDefined();
          if (!row) throw new Error('expected a dirty row from getEventsNeedingReconcile');
          return EventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.clearEventPersonalMessagesDirty(event.id, row.dirty_at)),
          );
        }),
        // Verify the marker is now NULL
        Effect.bind('afterClear', ({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe<{ dirty_at: string | null }>(
                `SELECT personal_messages_dirty_at AS dirty_at FROM events WHERE id = '${event.id}'`,
              ),
            ),
            Effect.map((rows) => rows[0]?.dirty_at ?? null),
          ),
        ),
        Effect.tap(({ afterClear }) =>
          Effect.sync(() => {
            expect(afterClear).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
