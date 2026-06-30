import { describe, expect, it } from '@effect/vitest';
import type { Discord, EventRpcEvents, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventSyncEventsRepository.Default,
  EventsRepository.Default,
  TeamMembersRepository.Default,
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KNOWN_START_AT = DateTime.makeUnsafe(Date.parse('2026-06-06T12:00:00.000Z'));
const KNOWN_END_AT = DateTime.makeUnsafe(Date.parse('2026-06-06T14:00:00.000Z'));
const TEST_GUILD_ID = '800000000000000001' as Discord.Snowflake;
const TEST_DISCORD_CHANNEL_ID = '800000000000000002' as Discord.Snowflake;

const trustedTeams: ReadonlyArray<EventRpcEvents.TeamsGeneratedTeam> = [
  {
    name: 'Team 1',
    avg_rating: 1300,
    members: [{ display_name: 'Alice', rating: 1300, is_calibrating: false }],
  },
  {
    name: 'Team 2',
    avg_rating: 1100,
    members: [{ display_name: 'Bob', rating: 1100, is_calibrating: true }],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventSyncEventsRepository — emitTeamsGenerated bug regression', () => {
  it.effect('round-trip: findUnprocessed returns the row with real start_at (not epoch 0)', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('800000000000000011', 'ese-user-1')),
      Effect.bind('team', ({ userId }) => createTeam(TEST_GUILD_ID, userId)),
      Effect.bind('member', ({ team, userId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: userId,
              active: true,
              joined_at: undefined,
            }),
          ),
        ),
      ),
      Effect.bind('event', ({ team, member }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              trainingTypeId: Option.none(),
              eventType: 'training',
              title: 'Integration Test Event',
              description: Option.none(),
              startAt: KNOWN_START_AT,
              endAt: Option.some(KNOWN_END_AT),
              location: Option.none(),
              createdBy: member.id,
            }),
          ),
        ),
      ),
      Effect.tap(({ team, event }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitTeamsGenerated(
              team.id,
              TEST_GUILD_ID,
              event.id,
              event.title,
              KNOWN_START_AT,
              Option.some(KNOWN_END_AT),
              Option.none(),
              trustedTeams,
            ),
          ),
        ),
      ),
      Effect.bind('rows', () =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(1);
          const row = rows[0]!;
          expect(row.event_type).toBe('teams_generated');
          // The bug stored "1970-01-01T00:00:00.000Z" (epoch 0). After fix the real start time is stored.
          expect(DateTime.toEpochMillis(row.event_start_at)).toBe(
            Date.parse('2026-06-06T12:00:00.000Z'),
          );
          expect(Option.isSome(row.event_end_at)).toBe(true);
          expect(DateTime.toEpochMillis(Option.getOrThrow(row.event_end_at))).toBe(
            Date.parse('2026-06-06T14:00:00.000Z'),
          );
          expect(Option.isSome(row.teams_payload)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'stored column is a bare ISO string — no leading double-quote (pre-fix had "1970-...Z")',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('800000000000000021', 'ese-user-2')),
        Effect.bind('team', ({ userId }) => createTeam(TEST_GUILD_ID, userId)),
        Effect.bind('member', ({ team, userId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.addMember({
                team_id: team.id,
                user_id: userId,
                active: true,
                joined_at: undefined,
              }),
            ),
          ),
        ),
        Effect.bind('event', ({ team, member }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertEvent({
                teamId: team.id,
                trainingTypeId: Option.none(),
                eventType: 'training',
                title: 'Raw Column Test Event',
                description: Option.none(),
                startAt: KNOWN_START_AT,
                endAt: Option.none(),
                location: Option.none(),
                createdBy: member.id,
              }),
            ),
          ),
        ),
        Effect.tap(({ team, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitTeamsGenerated(
                team.id,
                TEST_GUILD_ID,
                event.id,
                event.title,
                KNOWN_START_AT,
                Option.none(),
                Option.none(),
                trustedTeams,
              ),
            ),
          ),
        ),
        Effect.bind('rawRow', () =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) =>
                sql`SELECT event_start_at::text AS s FROM event_sync_events WHERE event_type = 'teams_generated'`,
            ),
          ),
        ),
        Effect.tap(({ rawRow }) =>
          Effect.sync(() => {
            const [{ s }] = Schema.decodeUnknownSync(
              Schema.Array(Schema.Struct({ s: Schema.String })),
            )(rawRow);
            // Must look like an ISO datetime (YYYY-MM-DDTHH:...)
            expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            // Pre-fix, the value was stored with a leading double-quote: "1970-...Z"
            expect(s.startsWith('"')).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('null end_at → SQL NULL: findUnprocessed row has Option.isNone(event_end_at)', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('800000000000000031', 'ese-user-3')),
      Effect.bind('team', ({ userId }) => createTeam(TEST_GUILD_ID, userId)),
      Effect.bind('member', ({ team, userId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: userId,
              active: true,
              joined_at: undefined,
            }),
          ),
        ),
      ),
      Effect.bind('event', ({ team, member }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              trainingTypeId: Option.none(),
              eventType: 'training',
              title: 'Null EndAt Event',
              description: Option.none(),
              startAt: KNOWN_START_AT,
              endAt: Option.none(),
              location: Option.none(),
              createdBy: member.id,
            }),
          ),
        ),
      ),
      Effect.tap(({ team, event }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitTeamsGenerated(
              team.id,
              TEST_GUILD_ID,
              event.id,
              event.title,
              KNOWN_START_AT,
              Option.none(),
              Option.none(),
              trustedTeams,
            ),
          ),
        ),
      ),
      Effect.bind('rows', () =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(1);
          const row = rows[0]!;
          expect(Option.isNone(row.event_end_at)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'poison-poll gone: batch with teams_generated + coaching_status decodes without throwing',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('800000000000000041', 'ese-user-4')),
        Effect.bind('team', ({ userId }) => createTeam(TEST_GUILD_ID, userId)),
        Effect.bind('member', ({ team, userId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.addMember({
                team_id: team.id,
                user_id: userId,
                active: true,
                joined_at: undefined,
              }),
            ),
          ),
        ),
        Effect.bind('event', ({ team, member }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertEvent({
                teamId: team.id,
                trainingTypeId: Option.none(),
                eventType: 'training',
                title: 'Poison Poll Event',
                description: Option.none(),
                startAt: KNOWN_START_AT,
                endAt: Option.some(KNOWN_END_AT),
                location: Option.none(),
                createdBy: member.id,
              }),
            ),
          ),
        ),
        // Row 1: teams_generated (the one that was poisoning the poll pre-fix)
        Effect.tap(({ team, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitTeamsGenerated(
                team.id,
                TEST_GUILD_ID,
                event.id,
                event.title,
                KNOWN_START_AT,
                Option.some(KNOWN_END_AT),
                Option.none(),
                trustedTeams,
              ),
            ),
          ),
        ),
        // Row 2: coaching_status (a sibling event type, simpler to emit)
        Effect.tap(({ team, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitCoachingStatus(
                team.id,
                event.id,
                event.title,
                KNOWN_START_AT,
                TEST_DISCORD_CHANNEL_ID,
              ),
            ),
          ),
        ),
        // findUnprocessed must decode both rows without throwing
        Effect.bind('rows', () =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findUnprocessed(10)),
          ),
        ),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            // Pre-fix: findUnprocessed would throw LogicError: SQL result parsing failed: Invalid DateTime input
            // because event_start_at for the teams_generated row contained the JSON-encoded string "1970-...Z"
            // (with literal double-quotes), which Schemas.DateTimeFromIsoString could not parse.
            expect(rows).toHaveLength(2);
            const eventTypes = rows.map((r) => r.event_type);
            expect(eventTypes).toContain('teams_generated');
            expect(eventTypes).toContain('coaching_status');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
