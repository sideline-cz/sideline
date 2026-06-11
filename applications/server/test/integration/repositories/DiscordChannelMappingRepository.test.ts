/**
 * Integration test for DiscordChannelMappingRepository.findGroupsMissingRole.
 *
 * This is the LOAD-BEARING test for the detection query — it proves the actual
 * WHERE clause works against a real PostgreSQL database with real rows.
 *
 * The old unit test (FindGroupsMissingRole.test.ts) used a mocked SqlClient that
 * returned canned rows unconditionally, meaning it could NEVER detect a wrong WHERE
 * clause.  This integration test replaces it as the source of truth.
 *
 * Canonical 7-fixture matrix:
 *
 *   GROUP_NO_MAPPING     — group, no discord_channel_mappings row          → EXPECTED returned
 *   GROUP_NULL_ROLE      — mapping row with discord_channel_id, role NULL  → EXPECTED returned
 *   GROUP_HAS_ROLE       — mapping row with discord_role_id set            → EXCLUDED
 *   GROUP_ARCHIVED       — is_archived=true, no role                       → EXCLUDED
 *   GROUP_TEAM_NO_GUILD  — in a team whose guild_id IS NULL                → EXCLUDED
 *   GROUP_IN_FLIGHT      — no role + unprocessed channel_created event     → EXCLUDED
 *   GROUP_PROCESSED_ONLY — no role + only PROCESSED channel_created event  → EXPECTED returned
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

const TestLayer = Layer.mergeAll(
  DiscordChannelMappingRepository.Default,
  ChannelSyncEventsRepository.Default,
  GroupsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** Creates a user and returns their UserId. */
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

/** Creates a team and returns it. */
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

// NOTE: The teams.guild_id column has a NOT NULL constraint (migration 1741200000_guild_linking.ts
// made it non-nullable). The WHERE t.guild_id IS NOT NULL clause in findGroupsMissingRole is
// therefore vacuously true and cannot filter anything in production — every team has a guild_id.
// The GROUP_TEAM_NO_GUILD fixture cannot be seeded in the real schema. We skip it and document the
// dead-code finding here instead.

/** Creates a group under a team and returns it. */
const createGroup = (
  teamId: import('@sideline/domain').Team.TeamId,
  name: string,
  emoji: Option.Option<string> = Option.none(),
  color: Option.Option<string> = Option.none(),
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insertGroup(teamId, name, Option.none(), emoji, color)),
  );

/** Archives a group by id. */
const archiveGroup = (groupId: import('@sideline/domain').GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

/** Manually mark a channel_sync_event as processed. */
const markEventProcessed = (
  eventId: import('@sideline/domain').ChannelSyncEvent.ChannelSyncEventId,
) =>
  ChannelSyncEventsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.markProcessed(eventId)),
  );

/** Find the first unprocessed event for a group to get its ID. */
const findFirstUnprocessedEventForGroup = (
  groupId: import('@sideline/domain').GroupModel.GroupId,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`
        SELECT id FROM channel_sync_events
        WHERE group_id = ${groupId} AND processed_at IS NULL AND error IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `,
    ),
    Effect.map((rows) => {
      const row = rows[0] as { id: string } | undefined;
      return row
        ? Option.some(row.id as import('@sideline/domain').ChannelSyncEvent.ChannelSyncEventId)
        : Option.none<import('@sideline/domain').ChannelSyncEvent.ChannelSyncEventId>();
    }),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscordChannelMappingRepository.findGroupsMissingRole', () => {
  it.effect(
    'canonical 6-fixture matrix: returns exactly {GROUP_NO_MAPPING, GROUP_NULL_ROLE, GROUP_PROCESSED_ONLY} and excludes the other 3',
    () =>
      Effect.gen(function* () {
        // ---- seed users and teams ----
        // NOTE: GROUP_TEAM_NO_GUILD is intentionally omitted — the teams.guild_id column has a
        // NOT NULL constraint (migration 1741200000_guild_linking.ts), so the WHERE t.guild_id IS NOT NULL
        // clause in findGroupsMissingRole is vacuously true.  There is no way to seed a team without
        // a guild_id in this schema.  The clause is dead code and cannot filter anything in practice.
        const userId = yield* createUser('800000000000000001', 'missing-role-user');
        const guildTeam = yield* createTeam('800000000000000002' as Discord.Snowflake, userId);

        // ---- GROUP_NO_MAPPING: group with no discord_channel_mappings row ----
        const groupNoMapping = yield* createGroup(guildTeam.id, 'GROUP_NO_MAPPING');

        // ---- GROUP_NULL_ROLE: mapping exists but discord_role_id IS NULL ----
        const groupNullRole = yield* createGroup(guildTeam.id, 'GROUP_NULL_ROLE');
        yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertGroupChannel(
              guildTeam.id,
              groupNullRole.id,
              '800000000000000010' as Discord.Snowflake,
            ),
          ),
        );
        // upsertGroupChannel sets discord_channel_id but leaves discord_role_id NULL — correct fixture

        // ---- GROUP_HAS_ROLE: mapping exists with discord_role_id set — must be EXCLUDED ----
        const groupHasRole = yield* createGroup(guildTeam.id, 'GROUP_HAS_ROLE');
        yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertRoleOnly(
              guildTeam.id,
              groupHasRole.id,
              '800000000000000020' as Discord.Snowflake,
            ),
          ),
        );

        // ---- GROUP_ARCHIVED: is_archived=true, no mapping — must be EXCLUDED ----
        const groupArchived = yield* createGroup(guildTeam.id, 'GROUP_ARCHIVED');
        yield* archiveGroup(groupArchived.id);

        // ---- GROUP_IN_FLIGHT: no role + unprocessed channel_created event — must be EXCLUDED ----
        const groupInFlight = yield* createGroup(guildTeam.id, 'GROUP_IN_FLIGHT');
        // emitChannelCreated looks up guild_id from teams table — this team has guild_id set
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitChannelCreated(guildTeam.id, groupInFlight.id, 'GROUP_IN_FLIGHT'),
          ),
        );
        // Leave the event unprocessed (processed_at IS NULL, error IS NULL)

        // ---- GROUP_PROCESSED_ONLY: no role + only PROCESSED channel_created event — must be RETURNED ----
        const groupProcessedOnly = yield* createGroup(guildTeam.id, 'GROUP_PROCESSED_ONLY');
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitChannelCreated(guildTeam.id, groupProcessedOnly.id, 'GROUP_PROCESSED_ONLY'),
          ),
        );
        // Find the event and mark it processed
        const maybeEventId = yield* findFirstUnprocessedEventForGroup(groupProcessedOnly.id);
        const eventId = Option.getOrThrow(maybeEventId);
        yield* markEventProcessed(eventId);

        // ---- Run the detection query ----
        const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findGroupsMissingRole(Option.none(), 100)),
        );

        const returnedIds = new Set(result.map((r) => r.group_id));

        // MUST be returned
        expect(returnedIds.has(groupNoMapping.id), 'GROUP_NO_MAPPING must be returned').toBe(true);
        expect(returnedIds.has(groupNullRole.id), 'GROUP_NULL_ROLE must be returned').toBe(true);
        expect(
          returnedIds.has(groupProcessedOnly.id),
          'GROUP_PROCESSED_ONLY must be returned',
        ).toBe(true);

        // MUST be excluded
        expect(returnedIds.has(groupHasRole.id), 'GROUP_HAS_ROLE must be excluded').toBe(false);
        expect(returnedIds.has(groupArchived.id), 'GROUP_ARCHIVED must be excluded').toBe(false);
        expect(returnedIds.has(groupInFlight.id), 'GROUP_IN_FLIGHT must be excluded').toBe(false);

        // Exactly 3 results (no spurious extras)
        expect(result).toHaveLength(3);

        // ----- discord_channel_id column assertions (partial-provisioning state) -----
        // GROUP_NULL_ROLE has discord_channel_id set (upsertGroupChannel set it) but no role.
        // This is the "channel exists, role missing" partial-provisioning state.
        // The backfill must route these groups to the LINK branch (not CREATE a new channel).
        // Pinning this ensures the routing logic can distinguish channel-exists from channel-absent.
        const rowNullRole = result.find((r) => r.group_id === groupNullRole.id)!;
        expect(
          Option.isSome(rowNullRole.discord_channel_id),
          'GROUP_NULL_ROLE must surface discord_channel_id as Some (channel-exists partial-provisioning)',
        ).toBe(true);
        expect(
          Option.getOrNull(rowNullRole.discord_channel_id),
          'GROUP_NULL_ROLE discord_channel_id must match the seeded snowflake',
        ).toBe('800000000000000010');

        // GROUP_NO_MAPPING has no discord_channel_mappings row at all — discord_channel_id is None.
        // The backfill must route this group to the CREATE branch.
        const rowNoMapping = result.find((r) => r.group_id === groupNoMapping.id)!;
        expect(
          Option.isNone(rowNoMapping.discord_channel_id),
          'GROUP_NO_MAPPING must surface discord_channel_id as None (no channel yet)',
        ).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("teamId scoping: Option.some(teamId) returns only that team's missing groups", () =>
    Effect.gen(function* () {
      const userId = yield* createUser('801000000000000001', 'scope-user');
      const teamA = yield* createTeam('801000000000000002' as Discord.Snowflake, userId);
      const teamB = yield* createTeam('801000000000000003' as Discord.Snowflake, userId);

      const groupA = yield* createGroup(teamA.id, 'Group in A');
      const groupB = yield* createGroup(teamB.id, 'Group in B');

      // Both groups are missing their role (no mapping rows)

      // Query scoped to teamA
      const resultA = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findGroupsMissingRole(Option.some(teamA.id), 100)),
      );

      // Query scoped to teamB
      const resultB = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findGroupsMissingRole(Option.some(teamB.id), 100)),
      );

      const idsA = resultA.map((r) => r.group_id);
      const idsB = resultB.map((r) => r.group_id);

      // teamA query returns groupA but NOT groupB
      expect(idsA).toContain(groupA.id);
      expect(idsA).not.toContain(groupB.id);

      // teamB query returns groupB but NOT groupA
      expect(idsB).toContain(groupB.id);
      expect(idsB).not.toContain(groupA.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('Option.none() returns groups across all guild-linked teams', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('802000000000000001', 'all-teams-user');
      const teamA = yield* createTeam('802000000000000002' as Discord.Snowflake, userId);
      const teamB = yield* createTeam('802000000000000003' as Discord.Snowflake, userId);

      const groupA = yield* createGroup(teamA.id, 'Cross-team Group A');
      const groupB = yield* createGroup(teamB.id, 'Cross-team Group B');

      const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findGroupsMissingRole(Option.none(), 100)),
      );

      const ids = result.map((r) => r.group_id);
      expect(ids).toContain(groupA.id);
      expect(ids).toContain(groupB.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('limit: with more than N missing groups, returns exactly N rows', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('803000000000000001', 'limit-user');
      const team = yield* createTeam('803000000000000002' as Discord.Snowflake, userId);

      // Create 3 groups, all missing roles
      yield* createGroup(team.id, 'Limit Group 1');
      yield* createGroup(team.id, 'Limit Group 2');
      yield* createGroup(team.id, 'Limit Group 3');

      const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findGroupsMissingRole(Option.none(), 1)),
      );

      expect(result).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returned rows carry correct name/emoji/color', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('804000000000000001', 'metadata-user');
      const team = yield* createTeam('804000000000000002' as Discord.Snowflake, userId);

      const group = yield* createGroup(
        team.id,
        'Fancy Group',
        Option.some('🔥'),
        Option.some('#ff6600'),
      );

      const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findGroupsMissingRole(Option.none(), 100)),
      );

      expect(result).toHaveLength(1);
      const row = result[0];
      expect(row?.group_id).toBe(group.id);
      expect(row?.name).toBe('Fancy Group');
      expect(Option.isSome(row?.emoji ?? Option.none())).toBe(true);
      expect(Option.getOrNull(row?.emoji ?? Option.none())).toBe('🔥');
      expect(Option.isSome(row?.color ?? Option.none())).toBe(true);
      expect(Option.getOrNull(row?.color ?? Option.none())).toBe('#ff6600');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'in-flight guard: error-flagged event (processed_at NULL, error SET) does NOT block provisioning',
    () =>
      Effect.gen(function* () {
        // A channel_sync_events row with error IS NOT NULL should NOT be treated as in-flight
        // The WHERE clause is: processed_at IS NULL AND error IS NULL
        // So a failed event (error set) is NOT in-flight → group MUST be returned
        const userId = yield* createUser('805000000000000001', 'errored-event-user');
        const team = yield* createTeam('805000000000000002' as Discord.Snowflake, userId);

        const group = yield* createGroup(team.id, 'Group With Errored Event');

        // Emit the event
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitChannelCreated(team.id, group.id, 'Group With Errored Event'),
          ),
        );
        // Mark it as failed (sets error, keeps processed_at NULL)
        const maybeEventId = yield* findFirstUnprocessedEventForGroup(group.id);
        const eventId = Option.getOrThrow(maybeEventId);
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markFailed(eventId, 'Discord API error')),
        );

        const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findGroupsMissingRole(Option.none(), 100)),
        );

        // The group MUST appear because its only event has an error (not truly in-flight)
        const returnedIds = result.map((r) => r.group_id);
        expect(returnedIds).toContain(group.id);
      }).pipe(Effect.provide(TestLayer)),
  );
});
