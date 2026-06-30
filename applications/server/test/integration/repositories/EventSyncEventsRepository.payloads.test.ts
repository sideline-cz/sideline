// NOTE: These tests are written in TDD mode BEFORE the implementation.
// These are REGRESSION tests for Part E.5 / E.3 of the plan.
//
// REGRESSION GUARD: After migration 1790100008 drops events.discord_target_channel_id,
// the following event types MUST still carry their discord_target_channel_id payloads
// in event_sync_events rows (they use the COLUMN FROM event_sync_events, not from events):
//
//   - 'rsvp_reminder' → discord_target_channel_id = the channel id
//   - 'training_claim_request' → discord_target_channel_id = the claim channel id
//   - 'teams_generated' → discord_target_channel_id = the channel id
//   - 'event_started' → discord_target_channel_id = the channel id
//   - 'event_created' / 'event_updated' → discord_target_channel_id = the global events channel
//
// These tests query the event_sync_events table directly after emitting events to verify
// that discord_target_channel_id is correctly stored. They will PASS against the current
// implementation but act as regression guards when the migration drops the events column.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
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
// Seed helpers
// ---------------------------------------------------------------------------

const TEST_GUILD_ID = '530000000000000001' as Discord.Snowflake;
const KNOWN_START_AT = DateTime.makeUnsafe(Date.parse('2027-07-10T14:00:00.000Z'));
const KNOWN_END_AT = DateTime.makeUnsafe(Date.parse('2027-07-10T16:00:00.000Z'));
const CHANNEL_ID = '530000000000000010' as Discord.Snowflake;

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
        name: 'Payload Regression Team',
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

const addMember = (teamId: import('@sideline/domain').Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const createTrainingEvent = (teamId: import('@sideline/domain').Team.TeamId, createdBy: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Regression Training',
        description: Option.none(),
        startAt: KNOWN_START_AT,
        endAt: Option.some(KNOWN_END_AT),
        location: Option.none(),
        trainingTypeId: Option.none(),
        createdBy: createdBy as any,
      }),
    ),
  );

const seedTeamWithMember = () =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser('531000000000000001', 'payload-reg-user')),
    Effect.bind('team', ({ userId }) => createTeam(TEST_GUILD_ID, userId)),
    Effect.bind('member', ({ team, userId }) => addMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, member })),
  );

// Helper: fetch the discord_target_channel_id from the latest event_sync_events row
const getLatestChannelId = (eventType: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ discord_target_channel_id: string | null }>(`
      SELECT discord_target_channel_id
      FROM event_sync_events
      WHERE event_type = '${eventType}'
      ORDER BY created_at DESC
      LIMIT 1
    `),
    ),
    Effect.map((rows) => rows[0]?.discord_target_channel_id ?? null),
  );

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe('EventSyncEventsRepository — discord_target_channel_id payload regression', () => {
  it.effect(
    'rsvp_reminder: emitRsvpReminder with a channel id stores it in event_sync_events.discord_target_channel_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember()),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
        Effect.tap(({ seed, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitRsvpReminder(
                seed.team.id,
                event.id,
                event.title,
                event.description,
                KNOWN_START_AT,
                Option.some(KNOWN_END_AT),
                Option.none(),
                'training',
                Option.some(CHANNEL_ID), // discord_target_channel_id
                Option.none(),
                Option.none(),
              ),
            ),
          ),
        ),
        Effect.bind('channelId', () => getLatestChannelId('rsvp_reminder')),
        Effect.tap(({ channelId }) =>
          Effect.sync(() => {
            // REGRESSION GUARD: discord_target_channel_id must be preserved
            expect(channelId).toBe(CHANNEL_ID);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'training_claim_request: emitTrainingClaimRequest stores discord_target_channel_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember()),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
        Effect.tap(({ seed, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitTrainingClaimRequest(
                seed.team.id,
                event.id,
                event.title,
                KNOWN_START_AT,
                Option.some(KNOWN_END_AT),
                Option.none(),
                event.description,
                CHANNEL_ID, // discordTargetChannelId (required, not optional for claim)
                Option.none(),
                Option.none(),
                Option.none(),
              ),
            ),
          ),
        ),
        Effect.bind('channelId', () => getLatestChannelId('training_claim_request')),
        Effect.tap(({ channelId }) =>
          Effect.sync(() => {
            expect(channelId).toBe(CHANNEL_ID);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('teams_generated: emitTeamsGenerated stores discord_target_channel_id', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember()),
      Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
      Effect.tap(({ seed, event }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitTeamsGenerated(
              seed.team.id,
              TEST_GUILD_ID,
              event.id,
              event.title,
              KNOWN_START_AT,
              Option.some(KNOWN_END_AT),
              Option.some(CHANNEL_ID), // discord_target_channel_id
              [
                {
                  name: 'Team 1',
                  avg_rating: 1300,
                  members: [{ display_name: 'Alice', rating: 1300, is_calibrating: false }],
                },
              ],
            ),
          ),
        ),
      ),
      Effect.bind('channelId', () => getLatestChannelId('teams_generated')),
      Effect.tap(({ channelId }) =>
        Effect.sync(() => {
          expect(channelId).toBe(CHANNEL_ID);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('event_started: emitEventStarted stores discord_target_channel_id', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember()),
      Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
      Effect.tap(({ seed, event }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitEventStarted(
              seed.team.id,
              event.id,
              event.title,
              event.description,
              KNOWN_START_AT,
              Option.some(KNOWN_END_AT),
              Option.none(),
              'training',
              Option.some(CHANNEL_ID), // discord_target_channel_id
              Option.none(),
              Option.none(),
              Option.none(),
              Option.none(),
              false,
            ),
          ),
        ),
      ),
      Effect.bind('channelId', () => getLatestChannelId('event_started')),
      Effect.tap(({ channelId }) =>
        Effect.sync(() => {
          expect(channelId).toBe(CHANNEL_ID);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'event_created: emitEventCreated with global channel stores discord_target_channel_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember()),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
        Effect.tap(({ seed, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitEventCreated(
                seed.team.id,
                event.id,
                event.title,
                event.description,
                KNOWN_START_AT,
                Option.some(KNOWN_END_AT),
                Option.none(),
                'training',
                Option.some(CHANNEL_ID), // the resolved global events channel id
                Option.none(),
                Option.none(),
                Option.none(),
                Option.none(),
                false,
              ),
            ),
          ),
        ),
        Effect.bind('channelId', () => getLatestChannelId('event_created')),
        Effect.tap(({ channelId }) =>
          Effect.sync(() => {
            // After Part E.5: event_created carries the global channel id
            expect(channelId).toBe(CHANNEL_ID);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'event_created: emitEventCreated with None channel stores NULL (no channel configured)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember()),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
        Effect.tap(({ seed, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitEventCreated(
                seed.team.id,
                event.id,
                event.title,
                event.description,
                KNOWN_START_AT,
                Option.some(KNOWN_END_AT),
                Option.none(),
                'training',
                Option.none(), // no global events channel configured
                Option.none(),
                Option.none(),
                Option.none(),
                Option.none(),
                false,
              ),
            ),
          ),
        ),
        Effect.bind('channelId', () => getLatestChannelId('event_created')),
        Effect.tap(({ channelId }) =>
          Effect.sync(() => {
            // When no global channel is configured, the channel id is NULL
            expect(channelId).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'event_updated: emitEventUpdated with global channel stores discord_target_channel_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember()),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
        Effect.tap(({ seed, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitEventUpdated(
                seed.team.id,
                event.id,
                event.title,
                event.description,
                KNOWN_START_AT,
                Option.some(KNOWN_END_AT),
                Option.none(),
                'training',
                Option.some(CHANNEL_ID), // the resolved global events channel id
                Option.none(),
                Option.none(),
                Option.none(),
                Option.none(),
                false,
              ),
            ),
          ),
        ),
        Effect.bind('channelId', () => getLatestChannelId('event_updated')),
        Effect.tap(({ channelId }) =>
          Effect.sync(() => {
            // After Part E.5: event_updated carries the global channel id
            expect(channelId).toBe(CHANNEL_ID);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'event_updated: emitEventUpdated with None channel stores NULL (no channel configured)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember()),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.member.id)),
        Effect.tap(({ seed, event }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitEventUpdated(
                seed.team.id,
                event.id,
                event.title,
                event.description,
                KNOWN_START_AT,
                Option.some(KNOWN_END_AT),
                Option.none(),
                'training',
                Option.none(), // no global events channel configured
                Option.none(),
                Option.none(),
                Option.none(),
                Option.none(),
                false,
              ),
            ),
          ),
        ),
        Effect.bind('channelId', () => getLatestChannelId('event_updated')),
        Effect.tap(({ channelId }) =>
          Effect.sync(() => {
            // When no global channel is configured, the channel id is NULL
            expect(channelId).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
