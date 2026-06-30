// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require:
//   - Migration 1790100001: ALTER TABLE team_settings ADD COLUMN discord_personal_events_category_id TEXT
//   - Migration 1790100006: ALTER TABLE team_settings ADD COLUMN discord_events_channel_id TEXT
//   - TeamSettingsRepository.upsert() to accept `discordPersonalEventsCategoryId` and
//     `discordEventsChannelId` optional parameters (both Option<Snowflake>)
//   - TeamSettingsRepository.findByTeamId() to return those two new fields
// These tests WILL FAIL until the implementation is complete.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamSettingsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers (mirror pattern from TeamSettingsRepository.reminder.test.ts)
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

const seedTeam = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.map(({ team }) => team),
  );

// ---------------------------------------------------------------------------
// Tests: discord_personal_events_category_id
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — discord_personal_events_category_id (migration 1790100001)', () => {
  it.effect('upsert with Some(categoryId) then findByTeamId returns Option.some(categoryId)', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam('310000000000000001', 'user-pec-1', '311010101010101010' as Discord.Snowflake),
      ),
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              // TDD: implement discordPersonalEventsCategoryId in upsert()
              discordPersonalEventsCategoryId: Option.some(
                '311111111111111111' as Discord.Snowflake,
              ),
            }),
          ),
        ),
      ),
      Effect.bind('settings', ({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          expect(Option.isSome(settings)).toBe(true);
          const row = Option.getOrThrow(settings);
          // TDD: implement discord_personal_events_category_id in TeamSettingsRow
          expect(Option.isSome(row.discord_personal_events_category_id)).toBe(true);
          expect(Option.getOrNull(row.discord_personal_events_category_id)).toBe(
            '311111111111111111',
          );
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('upsert with None then findByTeamId returns Option.none()', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam('312000000000000001', 'user-pec-2', '312020202020202020' as Discord.Snowflake),
      ),
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              discordPersonalEventsCategoryId: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('settings', ({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          expect(Option.isSome(settings)).toBe(true);
          const row = Option.getOrThrow(settings);
          expect(Option.isNone(row.discord_personal_events_category_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('PATCH then clear: set Some then upsert None clears to Option.none()', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam('313000000000000001', 'user-pec-3', '313030303030303030' as Discord.Snowflake),
      ),
      // First upsert with Some
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              discordPersonalEventsCategoryId: Option.some(
                '313111111111111111' as Discord.Snowflake,
              ),
            }),
          ),
        ),
      ),
      // Second upsert with None clears it
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              discordPersonalEventsCategoryId: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('settings', ({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          const row = Option.getOrThrow(settings);
          expect(Option.isNone(row.discord_personal_events_category_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'omitted discordPersonalEventsCategoryId key in PATCH (via raw SQL partial update) leaves value unchanged',
    () =>
      Effect.Do.pipe(
        Effect.bind('team', () =>
          seedTeam('314000000000000001', 'user-pec-4', '314040404040404040' as Discord.Snowflake),
        ),
        // Seed initial value via raw SQL (simulates a pre-existing row)
        Effect.tap(({ team }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`
              INSERT INTO team_settings (team_id, event_horizon_days, min_players_threshold,
                rsvp_reminders_enabled, rsvp_reminder_days_before, rsvp_reminder_time, timezone,
                discord_personal_events_category_id)
              VALUES ('${team.id}', 30, 5, false, 1, '18:00', 'UTC', '314111111111111111')
              ON CONFLICT (team_id) DO UPDATE SET
                discord_personal_events_category_id = '314111111111111111'
            `),
            ),
          ),
        ),
        // Partial update that does NOT touch discord_personal_events_category_id
        Effect.tap(({ team }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`
              UPDATE team_settings SET event_horizon_days = 60 WHERE team_id = '${team.id}'
            `),
            ),
          ),
        ),
        Effect.bind('settings', ({ team }) =>
          TeamSettingsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ settings }) =>
          Effect.sync(() => {
            const row = Option.getOrThrow(settings);
            // The value must still be Some after a partial update that did not touch it
            expect(Option.isSome(row.discord_personal_events_category_id)).toBe(true);
            expect(Option.getOrNull(row.discord_personal_events_category_id)).toBe(
              '314111111111111111',
            );
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Tests: discord_events_channel_id
// ---------------------------------------------------------------------------

describe('TeamSettingsRepository — discord_events_channel_id (migration 1790100006)', () => {
  it.effect('upsert with Some(channelId) then findByTeamId returns Option.some(channelId)', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam('320000000000000001', 'user-ec-1', '321010101010101010' as Discord.Snowflake),
      ),
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              // TDD: implement discordEventsChannelId in upsert()
              discordEventsChannelId: Option.some('321111111111111111' as Discord.Snowflake),
            }),
          ),
        ),
      ),
      Effect.bind('settings', ({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          expect(Option.isSome(settings)).toBe(true);
          const row = Option.getOrThrow(settings);
          // TDD: implement discord_events_channel_id in TeamSettingsRow
          expect(Option.isSome(row.discord_events_channel_id)).toBe(true);
          expect(Option.getOrNull(row.discord_events_channel_id)).toBe('321111111111111111');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('upsert with None then findByTeamId returns Option.none()', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam('322000000000000001', 'user-ec-2', '322020202020202020' as Discord.Snowflake),
      ),
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              discordEventsChannelId: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('settings', ({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          const row = Option.getOrThrow(settings);
          expect(Option.isNone(row.discord_events_channel_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('PATCH then clear: set Some then upsert None clears to Option.none()', () =>
    Effect.Do.pipe(
      Effect.bind('team', () =>
        seedTeam('323000000000000001', 'user-ec-3', '323030303030303030' as Discord.Snowflake),
      ),
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              discordEventsChannelId: Option.some('323111111111111111' as Discord.Snowflake),
            }),
          ),
        ),
      ),
      Effect.tap(({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId: team.id,
              eventHorizonDays: 30,
              minPlayersThreshold: 5,
              discordEventsChannelId: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('settings', ({ team }) =>
        TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          const row = Option.getOrThrow(settings);
          expect(Option.isNone(row.discord_events_channel_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'omitted discordEventsChannelId key in PATCH (via raw SQL partial update) leaves value unchanged',
    () =>
      Effect.Do.pipe(
        Effect.bind('team', () =>
          seedTeam('324000000000000001', 'user-ec-4', '324040404040404040' as Discord.Snowflake),
        ),
        Effect.tap(({ team }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`
              INSERT INTO team_settings (team_id, event_horizon_days, min_players_threshold,
                rsvp_reminders_enabled, rsvp_reminder_days_before, rsvp_reminder_time, timezone,
                discord_events_channel_id)
              VALUES ('${team.id}', 30, 5, false, 1, '18:00', 'UTC', '324111111111111111')
              ON CONFLICT (team_id) DO UPDATE SET
                discord_events_channel_id = '324111111111111111'
            `),
            ),
          ),
        ),
        Effect.tap(({ team }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(
                `UPDATE team_settings SET event_horizon_days = 60 WHERE team_id = '${team.id}'`,
              ),
            ),
          ),
        ),
        Effect.bind('settings', ({ team }) =>
          TeamSettingsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ settings }) =>
          Effect.sync(() => {
            const row = Option.getOrThrow(settings);
            expect(Option.isSome(row.discord_events_channel_id)).toBe(true);
            expect(Option.getOrNull(row.discord_events_channel_id)).toBe('324111111111111111');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
