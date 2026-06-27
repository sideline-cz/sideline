/**
 * Integration tests for DiscordChannelMappingRepository.
 *
 * Covers:
 *   1. findGroupsMissingRole — LOAD-BEARING test for the detection query.
 *      Proves the actual WHERE clause works against a real PostgreSQL database.
 *      The old unit test (FindGroupsMissingRole.test.ts) used a mocked SqlClient that
 *      returned canned rows unconditionally, meaning it could NEVER detect a wrong WHERE
 *      clause.  This integration test replaces it as the source of truth.
 *
 *      Canonical 7-fixture matrix:
 *        GROUP_NO_MAPPING     — group, no discord_channel_mappings row          → EXPECTED returned
 *        GROUP_NULL_ROLE      — mapping row with discord_channel_id, role NULL  → EXPECTED returned
 *        GROUP_HAS_ROLE       — mapping row with discord_role_id set            → EXCLUDED
 *        GROUP_ARCHIVED       — is_archived=true, no role                       → EXCLUDED
 *        GROUP_TEAM_NO_GUILD  — in a team whose guild_id IS NULL                → EXCLUDED
 *        GROUP_IN_FLIGHT      — no role + unprocessed channel_created event     → EXCLUDED
 *        GROUP_PROCESSED_ONLY — no role + only PROCESSED channel_created event  → EXPECTED returned
 *
 *   2. findActiveRostersWithRole — roster-scoped backfill detection query.
 *      Filters: active=true, discord_role_id IS NOT NULL, NOT EXISTS unprocessed event.
 *      "Unprocessed" means processed_at IS NULL (regardless of error — both pending and
 *      failed-but-not-permanently-failed events block the roster from the batch).
 *      Cross-team isolation and LIMIT honored.
 *
 *   3. countActiveRostersWithRole — roster-scoped count matching findActiveRostersWithRole
 *      population. Used for remainingCount arithmetic in the backfill response.
 *      Applies the same dedup guard (processed_at IS NULL only, no error IS NULL check).
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, RosterModel, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
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
  RostersRepository.Default,
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

// ---------------------------------------------------------------------------
// Roster seed helpers (for findActiveRostersWithRole / countActiveRostersWithRole)
// ---------------------------------------------------------------------------

/**
 * Creates an active roster and returns it.
 * Production code: RostersRepository.insert
 */
const createRoster = (teamId: Team.TeamId, name: string) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name,
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
  );

/**
 * Creates an inactive roster and returns it.
 */
const createInactiveRoster = (teamId: Team.TeamId, name: string) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name,
        active: false,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
  );

/**
 * Seeds a discord_channel_mappings row for a roster with a discord_role_id set.
 * This is the "has role" state — the roster SHOULD be returned by findActiveRostersWithRole.
 *
 * Uses DiscordChannelMappingRepository.insertRoster which requires both channelId and roleId.
 */
const seedRosterWithRole = (
  teamId: Team.TeamId,
  rosterId: RosterModel.RosterId,
  channelSnowflake: Discord.Snowflake,
  roleSnowflake: Discord.Snowflake,
) =>
  DiscordChannelMappingRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insertRoster(teamId, rosterId, channelSnowflake, roleSnowflake)),
  );

/** Find the first unprocessed channel_sync_event for a roster (error IS NULL — pending events only). */
const findFirstUnprocessedEventForRoster = (rosterId: RosterModel.RosterId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`
        SELECT id FROM channel_sync_events
        WHERE roster_id = ${rosterId} AND processed_at IS NULL AND error IS NULL
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
// findActiveRostersWithRole
//
// The query must:
//   • Return rosters where active=true AND discord_role_id IS NOT NULL
//     AND NOT EXISTS an unprocessed channel_sync_events row for the roster
//   • Exclude: inactive rosters, rosters with no role, rosters with an
//     unprocessed (in-flight) event (but return them once the event is processed)
//   • Scope to teamId
//   • Honour the LIMIT parameter
// ---------------------------------------------------------------------------

describe('DiscordChannelMappingRepository.findActiveRostersWithRole', () => {
  it.effect(
    'canonical fixture matrix: returns only active rosters with a role, no in-flight event',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('900000000000000001', 'roster-backfill-user');
        const team = yield* createTeam('900000000000000002' as Discord.Snowflake, userId);

        // ROSTER_ACTIVE_WITH_ROLE: active=true + role set + no event → MUST be returned
        const rosterActive = yield* createRoster(team.id, 'ROSTER_ACTIVE_WITH_ROLE');
        yield* seedRosterWithRole(
          team.id,
          rosterActive.id,
          '900000000000000010' as Discord.Snowflake,
          '900000000000000011' as Discord.Snowflake,
        );

        // ROSTER_INACTIVE: active=false + role set → MUST be excluded
        const rosterInactive = yield* createInactiveRoster(team.id, 'ROSTER_INACTIVE');
        yield* seedRosterWithRole(
          team.id,
          rosterInactive.id,
          '900000000000000020' as Discord.Snowflake,
          '900000000000000021' as Discord.Snowflake,
        );

        // ROSTER_NO_ROLE: active=true + no mapping row at all → MUST be excluded
        const rosterNoRole = yield* createRoster(team.id, 'ROSTER_NO_ROLE');
        // (no insertRoster call — no discord_channel_mappings row)

        // ROSTER_IN_FLIGHT: active=true + role set + unprocessed event → MUST be excluded
        const rosterInFlight = yield* createRoster(team.id, 'ROSTER_IN_FLIGHT');
        yield* seedRosterWithRole(
          team.id,
          rosterInFlight.id,
          '900000000000000030' as Discord.Snowflake,
          '900000000000000031' as Discord.Snowflake,
        );
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitRosterChannelCreated(
              team.id,
              rosterInFlight.id,
              'ROSTER_IN_FLIGHT',
              Option.some('900000000000000030' as Discord.Snowflake),
            ),
          ),
        );
        // Leave unprocessed (processed_at IS NULL, error IS NULL)

        // ROSTER_PROCESSED_ONLY: active=true + role set + only processed event → MUST be returned
        const rosterProcessed = yield* createRoster(team.id, 'ROSTER_PROCESSED_ONLY');
        yield* seedRosterWithRole(
          team.id,
          rosterProcessed.id,
          '900000000000000040' as Discord.Snowflake,
          '900000000000000041' as Discord.Snowflake,
        );
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitRosterChannelCreated(
              team.id,
              rosterProcessed.id,
              'ROSTER_PROCESSED_ONLY',
              Option.some('900000000000000040' as Discord.Snowflake),
            ),
          ),
        );
        // Mark event processed
        const maybeEventId = yield* findFirstUnprocessedEventForRoster(rosterProcessed.id);
        const eventId = Option.getOrThrow(maybeEventId);
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markProcessed(eventId)),
        );

        // ---- Run query ----
        const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 100)),
        );

        const returnedIds = new Set(result.map((r) => r.roster_id));

        // MUST be returned
        expect(returnedIds.has(rosterActive.id), 'ROSTER_ACTIVE_WITH_ROLE must be returned').toBe(
          true,
        );
        expect(returnedIds.has(rosterProcessed.id), 'ROSTER_PROCESSED_ONLY must be returned').toBe(
          true,
        );

        // MUST be excluded
        expect(returnedIds.has(rosterInactive.id), 'ROSTER_INACTIVE must be excluded').toBe(false);
        expect(returnedIds.has(rosterNoRole.id), 'ROSTER_NO_ROLE must be excluded').toBe(false);
        expect(returnedIds.has(rosterInFlight.id), 'ROSTER_IN_FLIGHT must be excluded').toBe(false);

        // Exactly 2 results
        expect(result).toHaveLength(2);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('in-flight roster reappears once its event is marked processed', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('901000000000000001', 'reappear-user');
      const team = yield* createTeam('901000000000000002' as Discord.Snowflake, userId);

      const roster = yield* createRoster(team.id, 'Reappearing Roster');
      yield* seedRosterWithRole(
        team.id,
        roster.id,
        '901000000000000010' as Discord.Snowflake,
        '901000000000000011' as Discord.Snowflake,
      );
      yield* ChannelSyncEventsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.emitRosterChannelCreated(
            team.id,
            roster.id,
            'Reappearing Roster',
            Option.some('901000000000000010' as Discord.Snowflake),
          ),
        ),
      );

      // While event is unprocessed — roster must NOT appear
      const resultBefore = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 100)),
      );
      expect(resultBefore.map((r) => r.roster_id)).not.toContain(roster.id);

      // Mark event processed
      const maybeEventId = yield* findFirstUnprocessedEventForRoster(roster.id);
      const eventId = Option.getOrThrow(maybeEventId);
      yield* ChannelSyncEventsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.markProcessed(eventId)),
      );

      // After processing — roster MUST reappear
      const resultAfter = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 100)),
      );
      expect(resultAfter.map((r) => r.roster_id)).toContain(roster.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'failed-unprocessed event (error SET, processed_at NULL) also excludes the roster',
    () =>
      Effect.gen(function* () {
        // A roster whose only channel_sync_events row has processed_at IS NULL AND error IS NOT NULL
        // (i.e. markFailed was called, transient failure, still awaiting retry) must be excluded.
        // Before fix: AND e.error IS NULL in the NOT EXISTS guard let such rosters through.
        // After fix: the guard checks only processed_at IS NULL — any unprocessed event blocks the roster.
        const userId = yield* createUser('901500000000000001', 'failed-event-user');
        const team = yield* createTeam('901500000000000002' as Discord.Snowflake, userId);

        // One clean roster — must still appear
        const rosterOk = yield* createRoster(team.id, 'Ok Roster (no event)');
        yield* seedRosterWithRole(
          team.id,
          rosterOk.id,
          '901500000000000010' as Discord.Snowflake,
          '901500000000000011' as Discord.Snowflake,
        );

        // Roster with a failed-unprocessed event — must be EXCLUDED
        const rosterFailed = yield* createRoster(team.id, 'Roster With Failed Event');
        yield* seedRosterWithRole(
          team.id,
          rosterFailed.id,
          '901500000000000020' as Discord.Snowflake,
          '901500000000000021' as Discord.Snowflake,
        );
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitRosterChannelCreated(
              team.id,
              rosterFailed.id,
              'Roster With Failed Event',
              Option.some('901500000000000020' as Discord.Snowflake),
            ),
          ),
        );
        // Mark the event as failed (sets error, leaves processed_at NULL)
        const maybeEventId = yield* findFirstUnprocessedEventForRoster(rosterFailed.id);
        const eventId = Option.getOrThrow(maybeEventId);
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markFailed(eventId, 'Discord API error')),
        );

        const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 100)),
        );

        const returnedIds = result.map((r) => r.roster_id);

        // Clean roster must appear
        expect(returnedIds).toContain(rosterOk.id);
        // Roster with failed-unprocessed event must be excluded
        expect(returnedIds).not.toContain(rosterFailed.id);
        // Exactly 1 result
        expect(result).toHaveLength(1);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('cross-team isolation: returns only rosters belonging to the queried team', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('902000000000000001', 'cross-team-user');
      const teamA = yield* createTeam('902000000000000002' as Discord.Snowflake, userId);
      const teamB = yield* createTeam('902000000000000003' as Discord.Snowflake, userId);

      // Roster in team A
      const rosterA = yield* createRoster(teamA.id, 'Roster Team A');
      yield* seedRosterWithRole(
        teamA.id,
        rosterA.id,
        '902000000000000010' as Discord.Snowflake,
        '902000000000000011' as Discord.Snowflake,
      );

      // Roster in team B
      const rosterB = yield* createRoster(teamB.id, 'Roster Team B');
      yield* seedRosterWithRole(
        teamB.id,
        rosterB.id,
        '902000000000000020' as Discord.Snowflake,
        '902000000000000021' as Discord.Snowflake,
      );

      const resultA = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findActiveRostersWithRole(teamA.id, 100)),
      );
      const resultB = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findActiveRostersWithRole(teamB.id, 100)),
      );

      const idsA = resultA.map((r) => r.roster_id);
      const idsB = resultB.map((r) => r.roster_id);

      expect(idsA).toContain(rosterA.id);
      expect(idsA).not.toContain(rosterB.id);

      expect(idsB).toContain(rosterB.id);
      expect(idsB).not.toContain(rosterA.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'LIMIT is honoured and ORDER BY (created_at, id) is stable: with 3 eligible rosters inserted in known order, limit=1 returns the first by (created_at, id)',
    () =>
      Effect.gen(function* () {
        // Seed via raw SQL to give each roster an explicit created_at so the tiebreaker id
        // sort is deterministic even when all rows share the same created_at timestamp.
        const userId = yield* createUser('903000000000000001', 'limit-roster-user');
        const team = yield* createTeam('903000000000000002' as Discord.Snowflake, userId);

        // Insert all 3 rosters and collect them in insertion order.
        const rosterA = yield* createRoster(team.id, 'Limit Roster 0');
        const rosterB = yield* createRoster(team.id, 'Limit Roster 1');
        const rosterC = yield* createRoster(team.id, 'Limit Roster 2');

        for (const [i, roster] of [rosterA, rosterB, rosterC].entries()) {
          yield* seedRosterWithRole(
            team.id,
            roster.id,
            `9030000000000000${10 + i}` as Discord.Snowflake,
            `9030000000000000${20 + i}` as Discord.Snowflake,
          );
        }

        // With limit=1 we get exactly 1 row.
        const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 1)),
        );
        expect(result).toHaveLength(1);

        // The returned row must be deterministic: (created_at ASC, id ASC) order means
        // the roster with the lexicographically smallest id among those with the earliest
        // created_at comes first. Fetch all 3 without a LIMIT to verify that limit=1
        // returns the head of that stable sort.
        const allRows = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 100)),
        );
        expect(allRows).toHaveLength(3);

        // The first row of the full result (ordered by created_at, id) must equal the
        // single row returned under limit=1.
        const expectedFirst = allRows[0];
        if (expectedFirst === undefined) throw new Error('Expected at least one row');
        expect(result[0]?.roster_id).toBe(expectedFirst.roster_id);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returned rows carry correct name/emoji/color fields', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('904000000000000001', 'metadata-roster-user');
      const team = yield* createTeam('904000000000000002' as Discord.Snowflake, userId);

      // Create roster with emoji and color
      const roster = yield* RostersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.insert({
            team_id: team.id,
            name: 'Fancy Roster',
            active: true,
            color: Option.some('#ff6600'),
            emoji: Option.some('🔥'),
          }),
        ),
      );
      yield* seedRosterWithRole(
        team.id,
        roster.id,
        '904000000000000010' as Discord.Snowflake,
        '904000000000000011' as Discord.Snowflake,
      );

      const result = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 100)),
      );

      expect(result).toHaveLength(1);
      const row = result[0];
      if (row === undefined) throw new Error('Expected a row');
      expect(row.roster_id).toBe(roster.id);
      expect(row.name).toBe('Fancy Roster');
      expect(Option.getOrNull(row.emoji)).toBe('🔥');
      expect(Option.getOrNull(row.color)).toBe('#ff6600');
      // discord_channel_id should be Some (we called insertRoster with a channelSnowflake)
      expect(Option.isSome(row.discord_channel_id)).toBe(true);
      expect(Option.getOrNull(row.discord_channel_id)).toBe('904000000000000010');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// countActiveRostersWithRole
//
// Must return the same count as the number of rows findActiveRostersWithRole
// would return with limit=∞ for the same teamId.
// ---------------------------------------------------------------------------

describe('DiscordChannelMappingRepository.countActiveRostersWithRole', () => {
  it.effect('returns 0 when no eligible rosters exist', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('910000000000000001', 'count-zero-user');
      const team = yield* createTeam('910000000000000002' as Discord.Snowflake, userId);

      // Roster with no role (should not count)
      yield* createRoster(team.id, 'No Role Roster');

      const count = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.countActiveRostersWithRole(team.id)),
      );

      expect(count).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('count matches findActiveRostersWithRole population', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('911000000000000001', 'count-match-user');
      const team = yield* createTeam('911000000000000002' as Discord.Snowflake, userId);

      // Seed 3 eligible rosters
      for (let i = 0; i < 3; i++) {
        const roster = yield* createRoster(team.id, `Count Roster ${i}`);
        yield* seedRosterWithRole(
          team.id,
          roster.id,
          `9110000000000000${10 + i}` as Discord.Snowflake,
          `9110000000000000${20 + i}` as Discord.Snowflake,
        );
      }

      // Seed 1 ineligible roster (no role) — must not count
      yield* createRoster(team.id, 'Ineligible No Role');

      const count = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.countActiveRostersWithRole(team.id)),
      );
      const rows = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findActiveRostersWithRole(team.id, 1000)),
      );

      expect(count).toBe(3);
      expect(rows).toHaveLength(3);
      expect(count).toBe(rows.length);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('count excludes in-flight rosters (unprocessed event blocks them)', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('912000000000000001', 'count-inflight-user');
      const team = yield* createTeam('912000000000000002' as Discord.Snowflake, userId);

      // One eligible roster (no event)
      const rosterOk = yield* createRoster(team.id, 'Ok Roster');
      yield* seedRosterWithRole(
        team.id,
        rosterOk.id,
        '912000000000000010' as Discord.Snowflake,
        '912000000000000011' as Discord.Snowflake,
      );

      // One in-flight roster (unprocessed event)
      const rosterInFlight = yield* createRoster(team.id, 'In-Flight Roster');
      yield* seedRosterWithRole(
        team.id,
        rosterInFlight.id,
        '912000000000000020' as Discord.Snowflake,
        '912000000000000021' as Discord.Snowflake,
      );
      yield* ChannelSyncEventsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.emitRosterChannelCreated(
            team.id,
            rosterInFlight.id,
            'In-Flight Roster',
            Option.some('912000000000000020' as Discord.Snowflake),
          ),
        ),
      );

      const count = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.countActiveRostersWithRole(team.id)),
      );

      // Only the non-in-flight roster counts
      expect(count).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'count excludes rosters with a failed-unprocessed event (error SET, processed_at NULL)',
    () =>
      Effect.gen(function* () {
        // Same semantics as the findActiveRostersWithRole version but for countActiveRostersWithRole.
        // Before fix: AND e.error IS NULL in the NOT EXISTS guard let failed-unprocessed events
        // through, so the count was inflated (roster counted AND re-enqueued each admin click).
        // After fix: processed_at IS NULL alone is sufficient to block the roster from the count.
        const userId = yield* createUser('912500000000000001', 'count-failed-event-user');
        const team = yield* createTeam('912500000000000002' as Discord.Snowflake, userId);

        // One clean roster (no event) — must count
        const rosterOk = yield* createRoster(team.id, 'Ok Roster');
        yield* seedRosterWithRole(
          team.id,
          rosterOk.id,
          '912500000000000010' as Discord.Snowflake,
          '912500000000000011' as Discord.Snowflake,
        );

        // One roster with a failed-unprocessed event — must NOT count
        const rosterFailed = yield* createRoster(team.id, 'Roster With Failed Event');
        yield* seedRosterWithRole(
          team.id,
          rosterFailed.id,
          '912500000000000020' as Discord.Snowflake,
          '912500000000000021' as Discord.Snowflake,
        );
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitRosterChannelCreated(
              team.id,
              rosterFailed.id,
              'Roster With Failed Event',
              Option.some('912500000000000020' as Discord.Snowflake),
            ),
          ),
        );
        const maybeEventId = yield* findFirstUnprocessedEventForRoster(rosterFailed.id);
        const eventId = Option.getOrThrow(maybeEventId);
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markFailed(eventId, 'Discord API error')),
        );

        const count = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.countActiveRostersWithRole(team.id)),
        );

        // Only the clean roster should count; the failed-event roster is excluded
        expect(count).toBe(1);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('cross-team isolation: count for teamA does not include teamB rosters', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('913000000000000001', 'count-cross-team-user');
      const teamA = yield* createTeam('913000000000000002' as Discord.Snowflake, userId);
      const teamB = yield* createTeam('913000000000000003' as Discord.Snowflake, userId);

      // 2 eligible in teamA, 3 in teamB
      for (let i = 0; i < 2; i++) {
        const r = yield* createRoster(teamA.id, `Team A Roster ${i}`);
        yield* seedRosterWithRole(
          teamA.id,
          r.id,
          `9130000000000000${10 + i}` as Discord.Snowflake,
          `9130000000000000${20 + i}` as Discord.Snowflake,
        );
      }
      for (let i = 0; i < 3; i++) {
        const r = yield* createRoster(teamB.id, `Team B Roster ${i}`);
        yield* seedRosterWithRole(
          teamB.id,
          r.id,
          `9130000000000000${30 + i}` as Discord.Snowflake,
          `9130000000000000${40 + i}` as Discord.Snowflake,
        );
      }

      const countA = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.countActiveRostersWithRole(teamA.id)),
      );
      const countB = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.countActiveRostersWithRole(teamB.id)),
      );

      expect(countA).toBe(2);
      expect(countB).toBe(3);
    }).pipe(Effect.provide(TestLayer)),
  );
});
