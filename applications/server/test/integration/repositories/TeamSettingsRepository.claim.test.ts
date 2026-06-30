// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require:
//   - TeamSettingsRepository.findEventsNeedingClaimRequestAt(now: Date) method
//   - New DB columns: events.claim_request_sent_at (timestamptz nullable)
//   - New DB column: team_settings.claim_request_days_before (int, default 3)
//   - The query must return training-type events whose lead-time day has been
//     reached (start_at - claim_request_days_before days <= now date) AND
//     claim_request_sent_at IS NULL AND start_at > now.
//
// ASSUMPTION: The result type is EventNeedingClaimRequest with at minimum:
//   { event_id, team_id, title, start_at, owner_group_id, member_group_id,
//     discord_target_channel_id, reminders_channel_id, timezone }
//
// ASSUMPTION: The query uses a LOWER-BOUND-OPEN gate (start_at - N days <= now)
//   NOT a strict BETWEEN window — so an event whose lead-time day HAS PASSED but
//   claim_request_sent_at is still NULL is still returned (self-healing).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamSettingsRepository.Default,
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
    Effect.map(({ team, member }) => ({ team, memberId: member.id })),
  );

/** Upsert team_settings with the new claim_request_days_before column via raw SQL.
 * ASSUMPTION: The column is called `claim_request_days_before` (int, default 3) on team_settings.
 */
const upsertSettingsWithClaimDays = (
  teamId: Team.TeamId,
  claimDaysBefore: number,
  timezone = 'UTC',
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`
        INSERT INTO team_settings (team_id, event_horizon_days, min_players_threshold,
          rsvp_reminders_enabled, rsvp_reminder_days_before, rsvp_reminder_time, timezone,
          claim_request_days_before)
        VALUES ('${teamId}', 30, 5, false, 1, '18:00', '${timezone}', ${claimDaysBefore})
        ON CONFLICT (team_id) DO UPDATE SET
          claim_request_days_before = ${claimDaysBefore},
          timezone = '${timezone}'
      `),
    ),
  );

/** Create a training event with explicit start_at. createdBy is the team_member.id (stringified). */
const createTrainingEvent = (
  teamId: Team.TeamId,
  createdBy: string,
  startAtIso: string,
  eventType = 'training',
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType,
        title: 'Test Training',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date(startAtIso)),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy: createdBy as any,
      }),
    ),
  );

/** Invoke findEventsNeedingClaimRequestAt with a pinned now Date. */
const findEventsNeedingClaimRequestAt = (now: Date) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findEventsNeedingClaimRequestAt(now)),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — findEventsNeedingClaimRequestAt', () => {
  it.effect(
    'returns training within lead-time window (start 2 days out, claim_request_days_before=3, sent_at NULL)',
    () =>
      Effect.Do.pipe(
        // Seed: team with settings claim_request_days_before=3
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '500000000000000001',
            'claim-owner-1',
            '501010101010101010' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettingsWithClaimDays(seed.team.id, 3)),
        // Event starts 2 days from now=2026-03-20T10:00:00Z → start_at = 2026-03-22T10:00:00Z
        // Lead-time check: 2026-03-22 - 3 days = 2026-03-19; now 2026-03-20 >= 2026-03-19 → INCLUDE
        Effect.tap(({ seed }) =>
          createTrainingEvent(seed.team.id, seed.memberId, '2026-03-22T10:00:00Z'),
        ),
        Effect.bind('events', () =>
          findEventsNeedingClaimRequestAt(new Date('2026-03-20T10:00:00Z')),
        ),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            expect(Array.isArray(events)).toBe(true);
            expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'self-healing: lead-time day has PASSED but claim_request_sent_at still NULL → returned',
    () =>
      Effect.Do.pipe(
        // The lead-time window was 3 days before a training 5 days from "seed".
        // We query with now = 1 day AFTER the lead-time day — should still be returned.
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '500000000000000002',
            'claim-owner-2',
            '502020202020202020' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettingsWithClaimDays(seed.team.id, 3)),
        // Training starts 2026-03-25; lead-time day = 2026-03-22
        // Query now = 2026-03-23 (1 day AFTER lead-time day but training still in future)
        Effect.tap(({ seed }) =>
          createTrainingEvent(seed.team.id, seed.memberId, '2026-03-25T10:00:00Z'),
        ),
        Effect.bind('events', () =>
          findEventsNeedingClaimRequestAt(new Date('2026-03-23T10:00:00Z')),
        ),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            // A BETWEEN-window query would wrongly return empty — assert ours returns it
            expect((events as unknown[]).length).toBeGreaterThanOrEqual(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'training 10 days out with claim_request_days_before=3 (lead-time day not yet reached) → NOT returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '500000000000000003',
            'claim-owner-3',
            '503030303030303030' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettingsWithClaimDays(seed.team.id, 3)),
        // Training starts 10 days from now; lead-time day = 7 days from now
        // now = 2026-03-20; start = 2026-03-30; lead day = 2026-03-27
        // now (2026-03-20) < lead day (2026-03-27) → NOT in scope yet
        Effect.tap(({ seed }) =>
          createTrainingEvent(seed.team.id, seed.memberId, '2026-03-30T10:00:00Z'),
        ),
        Effect.bind('events', () =>
          findEventsNeedingClaimRequestAt(new Date('2026-03-20T10:00:00Z')),
        ),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            expect((events as unknown[]).length).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('claim_request_sent_at already set → NOT returned (idempotency)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '500000000000000004',
          'claim-owner-4',
          '504040404040404040' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettingsWithClaimDays(seed.team.id, 3)),
      Effect.bind('event', ({ seed }) =>
        createTrainingEvent(seed.team.id, seed.memberId, '2026-03-22T10:00:00Z'),
      ),
      // Mark claim_request_sent_at via raw SQL
      Effect.tap(({ event }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`UPDATE events SET claim_request_sent_at = NOW() WHERE id = '${event.id}'`),
          ),
        ),
      ),
      Effect.bind('events', () =>
        findEventsNeedingClaimRequestAt(new Date('2026-03-20T10:00:00Z')),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('start_at <= now → NOT returned (already started/past)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '500000000000000005',
          'claim-owner-5',
          '505050505050505050' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettingsWithClaimDays(seed.team.id, 3)),
      // Event in the past relative to 'now'
      Effect.tap(({ seed }) =>
        createTrainingEvent(seed.team.id, seed.memberId, '2026-03-18T10:00:00Z'),
      ),
      Effect.bind('events', () =>
        findEventsNeedingClaimRequestAt(new Date('2026-03-20T10:00:00Z')),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('non-training event_type → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '500000000000000006',
          'claim-owner-6',
          '506060606060606060' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => upsertSettingsWithClaimDays(seed.team.id, 3)),
      // Create a 'match' event (not 'training')
      Effect.tap(({ seed }) =>
        createTrainingEvent(seed.team.id, seed.memberId, '2026-03-22T10:00:00Z', 'match'),
      ),
      Effect.bind('events', () =>
        findEventsNeedingClaimRequestAt(new Date('2026-03-20T10:00:00Z')),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect((events as unknown[]).length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'DST: Europe/Prague team, training around late-March DST transition → day arithmetic lands correctly',
    () =>
      Effect.Do.pipe(
        // Europe/Prague: CET (UTC+1) before last Sunday of March, CEST (UTC+2) after.
        // 2026-03-29 is DST day (clocks spring forward at 02:00 CET → 03:00 CEST).
        // Training on 2026-04-01 (Wednesday) with claim_request_days_before=3.
        // Lead-time day in Prague: 2026-03-29 (Sunday, DST day itself).
        // Query now = 2026-03-29T10:00:00Z. In Prague CEST that is 12:00 CEST (UTC+2).
        // Date in Prague = 2026-03-29.
        // Training start_at in Prague = 2026-04-01.
        // start_date - 3 days = 2026-03-29. now_date_prague = 2026-03-29. Equal → INCLUDE.
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '500000000000000007',
            'claim-dst-1',
            '507070707070707070' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => upsertSettingsWithClaimDays(seed.team.id, 3, 'Europe/Prague')),
        // Training at 2026-04-01T10:00:00Z (noon Prague CEST time = 12:00 UTC)
        Effect.tap(({ seed }) =>
          createTrainingEvent(seed.team.id, seed.memberId, '2026-04-01T10:00:00Z'),
        ),
        Effect.bind('returned', () =>
          findEventsNeedingClaimRequestAt(new Date('2026-03-29T10:00:00Z')),
        ),
        Effect.bind('notYet', () =>
          // 2 days before (2026-03-27 UTC): lead-time day NOT yet reached → empty
          findEventsNeedingClaimRequestAt(new Date('2026-03-27T10:00:00Z')),
        ),
        Effect.tap(({ returned, notYet }) =>
          Effect.sync(() => {
            expect((returned as unknown[]).length).toBeGreaterThanOrEqual(1);
            expect((notYet as unknown[]).length).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
