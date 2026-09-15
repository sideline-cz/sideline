/**
 * Integration tests for `backfillGroupRoleMembers` (bug 3db93506, PR 2, plan §5.3).
 *
 * Heals members whose group Discord CHANNEL role was never granted (joined Discord late,
 * manually, or while the bot was disconnected). A group-scoped sweep re-emits
 * `channel_created` for already-provisioned groups (channel + role both present), hitting
 * `handleCreated.ts` branch 3 (role present → reuse, no creation, no mapping write) and its
 * shared member backfill — re-syncing every direct and descendant member from one queue row.
 *
 * Covers:
 *   B1 — branch-3 contract: the emitted event must carry `existing_channel_id = None` and
 *        `discord_channel_name = None` (NOT `row.discord_channel_id`), or `handleCreated.ts`
 *        branch 1 fires and duplicates the Discord role.
 *   B2 — selection partitions cleanly against `findGroupsMissingRole`.
 *   B3 — the pending guard: an unprocessed `channel_created`/`channel_updated` event (with or
 *        without `error` set) excludes the group from re-emission.
 *   B4 — archived groups excluded.
 *   B5 — "nothing pending" counts, NOT a convergence proof.
 *   B6 — cross-team isolation.
 *   B7 — `processedCount` matches the number of rows actually enqueued.
 *   B8 — the global-admin all-teams invocation is paged one team per call, never unbounded.
 *        Drives the real `runGroupRoleBackfillPage` (shared by the HTTP handler and the CLI)
 *        rather than re-implementing its cursor logic, and exercises the `(created_at, id)`
 *        tuple tie-break with two teams sharing an identical `created_at`.
 *   B9 — `runGroupRoleBackfillPage` empty-page / termination edge cases: zero teams at all,
 *        and a cursor that already points past the only team.
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { applyDiscordFormat, DEFAULT_ROLE_FORMAT } from '~/utils/applyDiscordFormat.js';
import { backfillGroupRoleMembers } from '~/utils/backfillGroupRoleMembers.js';
import {
  runGroupRoleBackfillPage,
  TEAMS_PER_INVOCATION,
} from '~/utils/runGroupRoleBackfillPage.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

const TestLayer = Layer.mergeAll(
  DiscordChannelMappingRepository.Default,
  ChannelSyncEventsRepository.Default,
  GroupsRepository.Default,
  TeamsRepository.Default,
  TeamSettingsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers (mirrors test/integration/repositories/DiscordChannelMappingRepository.test.ts)
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

const createGroup = (
  teamId: Team.TeamId,
  name: string,
  emoji: Option.Option<string> = Option.none(),
  color: Option.Option<string> = Option.none(),
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insertGroup(teamId, name, Option.none(), emoji, color)),
  );

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

/** Seeds a fully-provisioned group (channel + role both present) — the population
 * `findActiveGroupsWithRole` / the sweep selects. */
const createProvisionedGroup = (
  teamId: Team.TeamId,
  name: string,
  channelId: Discord.Snowflake,
  roleId: Discord.Snowflake,
  emoji: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const group = yield* createGroup(teamId, name, emoji);
    yield* DiscordChannelMappingRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.insert(teamId, group.id, channelId, roleId)),
    );
    return group;
  });

/** Row shape read back from `channel_sync_events` for assertions the repository
 * layer doesn't otherwise expose (this table is intentionally read via raw SQL in
 * tests — see the sibling `findFirstUnprocessedEventForGroup` helper in
 * `DiscordChannelMappingRepository.test.ts`). */
type ChannelCreatedEventRow = {
  id: string;
  existing_channel_id: string | null;
  discord_channel_name: string | null;
  discord_role_name: string | null;
  processed_at: string | null;
  error: string | null;
};

const findChannelCreatedEventsForGroup = (groupId: GroupModel.GroupId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        SELECT id, existing_channel_id, discord_channel_name, discord_role_name, processed_at, error
        FROM channel_sync_events
        WHERE group_id = ${groupId} AND event_type = 'channel_created' AND entity_type = 'group'
        ORDER BY created_at ASC
      `,
    ),
    Effect.map((rows) => rows as unknown as ChannelCreatedEventRow[]),
  );

const countChannelCreatedEventsForGroups = (groupIds: readonly GroupModel.GroupId[]) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        SELECT COUNT(*)::int AS count
        FROM channel_sync_events
        WHERE group_id = ANY(${groupIds}) AND event_type = 'channel_created' AND entity_type = 'group'
      `,
    ),
    Effect.map((rows) => (rows[0] as { count: number } | undefined)?.count ?? 0),
  );

const markFirstEventFailed = (groupId: GroupModel.GroupId, message: string) =>
  Effect.gen(function* () {
    const events = yield* findChannelCreatedEventsForGroup(groupId);
    const target = events[0];
    if (target === undefined) throw new Error(`Expected an event for group ${groupId}`);
    yield* ChannelSyncEventsRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.markFailed(target.id as never, message)),
    );
  });

/** Simulates the bot fully draining the channel-sync queue for a team: marks every
 * `channel_created` event processed. Used by B5 to demonstrate that "nothing
 * currently pending" is not a convergence proof — once the queue drains, the same
 * 60 groups are eligible again. */
const markAllChannelCreatedEventsProcessed = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        UPDATE channel_sync_events
        SET processed_at = now()
        WHERE team_id = ${teamId} AND event_type = 'channel_created' AND processed_at IS NULL
      `,
    ),
  );

// ---------------------------------------------------------------------------
// B1 — branch-3 contract (highest value)
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B1: branch-3 contract', () => {
  it.effect(
    'emits exactly one channel_created/group row with existing_channel_id=NULL, discord_channel_name=NULL, and a correctly-formatted discord_role_name',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('600000000000000001', 'b1-user');
        const team = yield* createTeam('600000000000000002' as Discord.Snowflake, userId);

        const channelId = '600000000000000010' as Discord.Snowflake;
        const roleId = '600000000000000011' as Discord.Snowflake;
        const group = yield* createProvisionedGroup(
          team.id,
          'Goalkeepers',
          channelId,
          roleId,
          Option.some('🥅'),
        );

        const result = yield* backfillGroupRoleMembers(team.id);
        expect(result.processedCount).toBe(1);
        expect(result.remainingCount).toBe(0);

        const events = yield* findChannelCreatedEventsForGroup(group.id);
        expect(events).toHaveLength(1);
        const event = events[0]!;

        // THE regression this test exists to catch: if the emit ever passes
        // row.discord_channel_id as existing_channel_id, handleCreated.ts branch 1
        // fires createRoleForChannel unconditionally and duplicates the role.
        expect(
          event.existing_channel_id,
          'existing_channel_id MUST be NULL — passing the existing channel id here ' +
            'routes to handleCreated.ts branch 1, which unconditionally creates a ' +
            'second Discord role for an already-provisioned group',
        ).toBeNull();
        expect(event.discord_channel_name).toBeNull();

        // No settings row was seeded for this team, so TeamSettingsRepository.findByTeamId
        // returns None and the DEFAULT_ROLE_FORMAT applies — pin the real formatting
        // function output, not just "some non-null string".
        const expectedRoleName = applyDiscordFormat(
          DEFAULT_ROLE_FORMAT,
          'Goalkeepers',
          Option.some('🥅'),
        );
        expect(event.discord_role_name).toBe(expectedRoleName);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B2 — partition vs findGroupsMissingRole
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B2: partition vs findGroupsMissingRole', () => {
  it.effect(
    'selects only the fully-provisioned group; the other two remain owned by findGroupsMissingRole',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('601000000000000001', 'b2-user');
        const team = yield* createTeam('601000000000000002' as Discord.Snowflake, userId);

        // Channel set, role NULL — owned by findGroupsMissingRole.
        const groupNullRole = yield* createGroup(team.id, 'Null Role Group');
        yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertGroupChannel(
              team.id,
              groupNullRole.id,
              '601000000000000010' as Discord.Snowflake,
            ),
          ),
        );

        // No mapping row at all — owned by findGroupsMissingRole.
        const groupNoMapping = yield* createGroup(team.id, 'No Mapping Group');

        // Fully provisioned — owned by findActiveGroupsWithRole / the sweep.
        const groupProvisioned = yield* createProvisionedGroup(
          team.id,
          'Provisioned Group',
          '601000000000000020' as Discord.Snowflake,
          '601000000000000021' as Discord.Snowflake,
        );

        const activeWithRole = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findActiveGroupsWithRole(team.id, 100)),
        );
        const activeIds = activeWithRole.map((r) => r.group_id);
        expect(activeIds).toContain(groupProvisioned.id);
        expect(activeIds).not.toContain(groupNullRole.id);
        expect(activeIds).not.toContain(groupNoMapping.id);
        expect(activeWithRole).toHaveLength(1);

        // Same call, same test: the other two must still be visible to the OTHER sweep.
        const missingRole = yield* DiscordChannelMappingRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findGroupsMissingRole(Option.some(team.id), 100)),
        );
        const missingIds = missingRole.map((r) => r.group_id);
        expect(missingIds).toContain(groupNullRole.id);
        expect(missingIds).toContain(groupNoMapping.id);
        expect(missingIds).not.toContain(groupProvisioned.id);

        // And the actual backfill util only processes the provisioned one.
        const result = yield* backfillGroupRoleMembers(team.id);
        expect(result.processedCount).toBe(1);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B3 — pending guard (processed_at IS NULL only — an errored-but-unprocessed
// event is still mid-retry and must still block re-emission)
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B3: pending guard', () => {
  it.effect(
    'neither a clean-unprocessed nor an errored-unprocessed channel_created event is re-emitted',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('602000000000000001', 'b3-user');
        const team = yield* createTeam('602000000000000002' as Discord.Snowflake, userId);

        // Group A: provisioned, with a clean unprocessed channel_created event pending.
        const groupA = yield* createProvisionedGroup(
          team.id,
          'Pending Clean',
          '602000000000000010' as Discord.Snowflake,
          '602000000000000011' as Discord.Snowflake,
        );
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emitChannelCreated(team.id, groupA.id, groupA.name)),
        );

        // Group B: provisioned, with an ERRORED-but-unprocessed channel_created event
        // (still mid-retry — must still block, per AGENTS.md:607: guard is
        // processed_at IS NULL ONLY, do NOT add AND error IS NULL).
        const groupB = yield* createProvisionedGroup(
          team.id,
          'Pending Errored',
          '602000000000000020' as Discord.Snowflake,
          '602000000000000021' as Discord.Snowflake,
        );
        yield* ChannelSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emitChannelCreated(team.id, groupB.id, groupB.name)),
        );
        yield* markFirstEventFailed(groupB.id, 'transient Discord API error');

        const result = yield* backfillGroupRoleMembers(team.id);
        expect(result.processedCount, 'neither pending group should be re-emitted').toBe(0);
        expect(result.remainingCount).toBe(0);

        // Exactly the one pre-existing event per group — no duplicate emitted.
        const eventsA = yield* findChannelCreatedEventsForGroup(groupA.id);
        const eventsB = yield* findChannelCreatedEventsForGroup(groupB.id);
        expect(eventsA).toHaveLength(1);
        expect(eventsB).toHaveLength(1);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B4 — archived groups excluded
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B4: archived group excluded', () => {
  it.effect('an archived, fully-provisioned group is not selected', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('603000000000000001', 'b4-user');
      const team = yield* createTeam('603000000000000002' as Discord.Snowflake, userId);

      const group = yield* createProvisionedGroup(
        team.id,
        'Archived Group',
        '603000000000000010' as Discord.Snowflake,
        '603000000000000011' as Discord.Snowflake,
      );
      yield* archiveGroup(group.id);

      const active = yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findActiveGroupsWithRole(team.id, 100)),
      );
      expect(active.map((r) => r.group_id)).not.toContain(group.id);

      const result = yield* backfillGroupRoleMembers(team.id);
      expect(result.processedCount).toBe(0);
      expect(result.remainingCount).toBe(0);

      const events = yield* findChannelCreatedEventsForGroup(group.id);
      expect(events).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B5 — "nothing pending" counts, NOT a convergence proof
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B5: drain arithmetic is not convergence', () => {
  it.effect(
    '60 provisioned groups: call 1 processes 50/remaining 10, call 2 processes the last 10/remaining 0, ' +
      'call 3 processes 0 — and once the queue drains, a 4th call re-emits all 60 again',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('604000000000000001', 'b5-user');
        const team = yield* createTeam('604000000000000002' as Discord.Snowflake, userId);

        const groupIds: GroupModel.GroupId[] = [];
        for (let i = 0; i < 60; i++) {
          const channelId = `6040000000${String(i).padStart(8, '0')}` as Discord.Snowflake;
          const roleId = `6041000000${String(i).padStart(8, '0')}` as Discord.Snowflake;
          const group = yield* createProvisionedGroup(team.id, `Group ${i}`, channelId, roleId);
          groupIds.push(group.id);
        }

        // Call 1: BACKFILL_LIMIT = 50 of the 60 eligible groups are processed; the other
        // 10 remain eligible (their events haven't been emitted yet).
        const call1 = yield* backfillGroupRoleMembers(team.id);
        expect(call1.processedCount).toBe(50);
        expect(call1.remainingCount).toBe(10);

        // Call 2: the 50 just-emitted groups are now excluded by the pending guard (their
        // channel_created event is unprocessed); the remaining 10 are emitted.
        const call2 = yield* backfillGroupRoleMembers(team.id);
        expect(call2.processedCount).toBe(10);
        expect(call2.remainingCount).toBe(0);

        // Call 3: every group now has a pending event — nothing left to emit. This is
        // "nothing CURRENTLY pending", not a proof that every member actually holds the
        // role: the bot may not have processed the queue at all yet.
        const call3 = yield* backfillGroupRoleMembers(team.id);
        expect(call3.processedCount).toBe(0);
        expect(call3.remainingCount).toBe(0);

        // Simulate the bot fully draining the queue (marking every event processed).
        // The sweep has no state of its own beyond "is there an unprocessed event" —
        // once that clears, all 60 groups are eligible again, and a manual trigger
        // (captain button or admin invocation) legitimately re-emits all 60. This is
        // correct behaviour for a manual, idempotent re-sync — NOT evidence that the
        // sweep converges to a fixed point on its own.
        yield* markAllChannelCreatedEventsProcessed(team.id);
        const call4 = yield* backfillGroupRoleMembers(team.id);
        expect(
          call4.processedCount,
          'once the queue drains, the sweep re-emits for every eligible group again',
        ).toBe(50);
        expect(call4.remainingCount).toBe(10);

        // Sanity: total channel_created rows ever created for these 60 groups is
        // 60 (calls 1+2) + 50 (call 4) = 110 — i.e. duplicate emission per drain cycle,
        // by design (idempotent re-sync), not a bug.
        const totalEvents = yield* countChannelCreatedEventsForGroups(groupIds);
        expect(totalEvents).toBe(110);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B6 — cross-team isolation
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B6: cross-team isolation', () => {
  it.effect("a call for team A only processes team A's groups", () =>
    Effect.gen(function* () {
      const userId = yield* createUser('605000000000000001', 'b6-user');
      const teamA = yield* createTeam('605000000000000002' as Discord.Snowflake, userId);
      const teamB = yield* createTeam('605000000000000003' as Discord.Snowflake, userId);

      const groupA1 = yield* createProvisionedGroup(
        teamA.id,
        'Team A Group 1',
        '605000000000000010' as Discord.Snowflake,
        '605000000000000011' as Discord.Snowflake,
      );
      const groupA2 = yield* createProvisionedGroup(
        teamA.id,
        'Team A Group 2',
        '605000000000000012' as Discord.Snowflake,
        '605000000000000013' as Discord.Snowflake,
      );
      const groupB1 = yield* createProvisionedGroup(
        teamB.id,
        'Team B Group 1',
        '605000000000000020' as Discord.Snowflake,
        '605000000000000021' as Discord.Snowflake,
      );

      const result = yield* backfillGroupRoleMembers(teamA.id);
      expect(result.processedCount).toBe(2);

      const eventsA1 = yield* findChannelCreatedEventsForGroup(groupA1.id);
      const eventsA2 = yield* findChannelCreatedEventsForGroup(groupA2.id);
      const eventsB1 = yield* findChannelCreatedEventsForGroup(groupB1.id);
      expect(eventsA1).toHaveLength(1);
      expect(eventsA2).toHaveLength(1);
      expect(eventsB1, "team B's group must be untouched by a team-A-scoped call").toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B7 — counts match what was actually enqueued
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B7: counts match enqueued rows', () => {
  it.effect(
    'processedCount === 10 and exactly 10 channel_sync_events rows exist for those groups',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('606000000000000001', 'b7-user');
        const team = yield* createTeam('606000000000000002' as Discord.Snowflake, userId);

        const groupIds: GroupModel.GroupId[] = [];
        for (let i = 0; i < 10; i++) {
          const channelId = `6060000000${String(i).padStart(8, '0')}` as Discord.Snowflake;
          const roleId = `6061000000${String(i).padStart(8, '0')}` as Discord.Snowflake;
          const group = yield* createProvisionedGroup(team.id, `Group ${i}`, channelId, roleId);
          groupIds.push(group.id);
        }

        const result = yield* backfillGroupRoleMembers(team.id);
        expect(result.processedCount).toBe(10);

        const totalEvents = yield* countChannelCreatedEventsForGroups(groupIds);
        expect(
          totalEvents,
          'the honest-counts property: processedCount must equal rows actually enqueued',
        ).toBe(10);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B8 — the global-admin invocation is paged one team per call, never all-teams
//
// Drives the REAL `runGroupRoleBackfillPage` (`src/utils/runGroupRoleBackfillPage.ts`)
// — the exact function shared by the HTTP handler (`api/global-admin.ts`) and the
// `backfillGroupRoleMembersCli.ts` operator script — instead of re-implementing its
// `findTeamIdsAfter` → `Effect.forEach` → `nextAfter` ternary → `countTeamsAfter`
// pipeline inline. Breaking the handler's cursor logic (or deleting
// `requireGlobalAdmin`, which this test never touches) must break THIS test.
//
// Also seeds two teams with an IDENTICAL `created_at` so the `(created_at, id) > (…)`
// tuple comparison is actually exercised — the whole reason the cursor is a tuple
// rather than a bare timestamp is to break exactly this kind of tie. A fixture where
// every team gets a distinct timestamp never touches that comparator branch.
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B8: admin invocation walks the real runGroupRoleBackfillPage', () => {
  it.effect(
    `three teams (two sharing an identical created_at) at TEAMS_PER_INVOCATION=${TEAMS_PER_INVOCATION}: one call per team, remainingTeams walks 2 → 1 → 0, nextAfter is Option.none() exactly when remainingTeams is 0, no team visited twice`,
    () =>
      Effect.gen(function* () {
        // Guards TEAMS_PER_INVOCATION itself, not just its effect below — a future
        // bump would silently invalidate this test's page-boundary assertions.
        expect(TEAMS_PER_INVOCATION).toBe(1);

        const userId = yield* createUser('607000000000000001', 'b8-user');
        const teamA = yield* createTeam('607000000000000002' as Discord.Snowflake, userId);
        const teamB = yield* createTeam('607000000000000003' as Discord.Snowflake, userId);
        const teamC = yield* createTeam('607000000000000004' as Discord.Snowflake, userId);

        const groupA = yield* createProvisionedGroup(
          teamA.id,
          'Team A Group',
          '607000000000000010' as Discord.Snowflake,
          '607000000000000011' as Discord.Snowflake,
        );
        const groupB = yield* createProvisionedGroup(
          teamB.id,
          'Team B Group',
          '607000000000000020' as Discord.Snowflake,
          '607000000000000021' as Discord.Snowflake,
        );
        const groupC = yield* createProvisionedGroup(
          teamC.id,
          'Team C Group',
          '607000000000000030' as Discord.Snowflake,
          '607000000000000031' as Discord.Snowflake,
        );

        const groupIdByTeamId = new Map<Team.TeamId, GroupModel.GroupId>([
          [teamA.id, groupA.id],
          [teamB.id, groupB.id],
          [teamC.id, groupC.id],
        ]);

        const sql = yield* SqlClient.SqlClient.asEffect();
        // Force A and B onto the exact same created_at. C is pinned strictly later so
        // it always sorts last regardless of how the A/B tie resolves on `id`.
        yield* sql`UPDATE teams SET created_at = '2024-01-01T00:00:00Z' WHERE id IN (${teamA.id}, ${teamB.id})`;
        yield* sql`UPDATE teams SET created_at = '2024-01-02T00:00:00Z' WHERE id = ${teamC.id}`;

        // Ask the database for the real walk order rather than assuming which of the
        // tied A/B rows sorts first — the tie-break is on `id`, which is arbitrary
        // (gen_random_uuid()) and must not be hard-coded into the test.
        const orderRows = (yield* sql`
          SELECT id FROM teams WHERE id IN (${teamA.id}, ${teamB.id}, ${teamC.id})
          ORDER BY created_at, id
        `) as unknown as { id: string }[];
        const expectedOrder = orderRows.map((r) => r.id as Team.TeamId);
        expect(expectedOrder).toHaveLength(3);
        expect(expectedOrder[2], 'the later created_at (team C) always sorts last').toBe(teamC.id);

        // ---- Call 1 ----
        const page1 = yield* runGroupRoleBackfillPage(Option.none());
        expect(page1.processedCount).toBe(1);
        expect(page1.remainingCount).toBe(0);
        expect(page1.remainingTeams).toBe(2);
        expect(Option.isSome(page1.nextAfter)).toBe(true);
        expect(Option.getOrThrow(page1.nextAfter)).toBe(expectedOrder[0]);

        expect(
          yield* findChannelCreatedEventsForGroup(groupIdByTeamId.get(expectedOrder[0]!)!),
        ).toHaveLength(1);
        expect(
          yield* findChannelCreatedEventsForGroup(groupIdByTeamId.get(expectedOrder[1]!)!),
        ).toHaveLength(0);
        expect(yield* findChannelCreatedEventsForGroup(groupC.id)).toHaveLength(0);

        // ---- Call 2 ----
        const page2 = yield* runGroupRoleBackfillPage(page1.nextAfter);
        expect(page2.processedCount).toBe(1);
        expect(page2.remainingCount).toBe(0);
        expect(page2.remainingTeams).toBe(1);
        expect(Option.isSome(page2.nextAfter)).toBe(true);
        expect(Option.getOrThrow(page2.nextAfter)).toBe(expectedOrder[1]);

        // Team visited in call 1 is untouched (still exactly one event — not visited
        // twice); the team visited in call 2 now has its event; team C is still untouched.
        expect(
          yield* findChannelCreatedEventsForGroup(groupIdByTeamId.get(expectedOrder[0]!)!),
        ).toHaveLength(1);
        expect(
          yield* findChannelCreatedEventsForGroup(groupIdByTeamId.get(expectedOrder[1]!)!),
        ).toHaveLength(1);
        expect(yield* findChannelCreatedEventsForGroup(groupC.id)).toHaveLength(0);

        // ---- Call 3 ----
        const page3 = yield* runGroupRoleBackfillPage(page2.nextAfter);
        expect(page3.processedCount).toBe(1);
        expect(page3.remainingCount).toBe(0);
        expect(page3.remainingTeams, 'after walking all three teams, nothing remains').toBe(0);
        expect(
          page3.nextAfter,
          'nextAfter must be Option.none() EXACTLY when remainingTeams is 0',
        ).toEqual(Option.none());

        // No team was ever visited twice: every group has exactly one event.
        expect(yield* findChannelCreatedEventsForGroup(groupA.id)).toHaveLength(1);
        expect(yield* findChannelCreatedEventsForGroup(groupB.id)).toHaveLength(1);
        expect(yield* findChannelCreatedEventsForGroup(groupC.id)).toHaveLength(1);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B9 — runGroupRoleBackfillPage empty-page / termination edge cases
//
// New code (`runGroupRoleBackfillPage.ts`) shared by two callers (the HTTP handler
// and the CLI script) with no direct test of its own before this file. B8 above
// exercises the "teams remain" walk; these two cover the boundary it never reaches:
// zero teams in the database at all, and a page whose `after` cursor already points
// past the only team (an empty `teamIds` page).
// ---------------------------------------------------------------------------

describe('backfillGroupRoleMembers — B9: runGroupRoleBackfillPage empty-page / termination', () => {
  it.effect(
    'zero teams in the database: processedCount 0, remainingTeams 0, nextAfter is Option.none()',
    () =>
      Effect.gen(function* () {
        const page = yield* runGroupRoleBackfillPage(Option.none());
        expect(page.processedCount).toBe(0);
        expect(page.remainingCount).toBe(0);
        expect(page.remainingTeams).toBe(0);
        expect(page.nextAfter).toEqual(Option.none());
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'cursor already points past the only team: empty teamIds page, processedCount 0, nextAfter stays Option.none(), the existing team is not re-processed',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('608000000000000001', 'b9-user');
        const team = yield* createTeam('608000000000000002' as Discord.Snowflake, userId);
        const group = yield* createProvisionedGroup(
          team.id,
          'Only Group',
          '608000000000000010' as Discord.Snowflake,
          '608000000000000011' as Discord.Snowflake,
        );

        // A caller resuming with a stale cursor that already sits at the last known
        // team must get a genuinely empty page back, not an error and not a re-walk.
        const page = yield* runGroupRoleBackfillPage(Option.some(team.id));
        expect(page.processedCount).toBe(0);
        expect(page.remainingCount).toBe(0);
        expect(page.remainingTeams).toBe(0);
        expect(page.nextAfter).toEqual(Option.none());

        // The one pre-existing group must not have gained a second channel_created
        // event from this empty page.
        expect(yield* findChannelCreatedEventsForGroup(group.id)).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );
});
