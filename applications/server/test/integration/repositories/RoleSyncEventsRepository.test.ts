// Integration coverage for PR-7 (root cause D):
//   - emitRoleAssigned actually inserts a row that the bot's findUnprocessed query returns
//     (root cause D was that nothing ever called these emit* functions in production).
//   - emitRoleAssigned no-ops (writes nothing) when `lookupGuildId` finds no matching team row —
//     the `_emitIfGuildLinked` onNone branch.
//   - TeamMembersRepository.findEffectiveRoleIdsForMember (PR-7 step 3) returns both directly
//     assigned and group-inherited roles, deduplicated.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  RoleSyncEventsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

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
        name: 'Role Sync Events Test Team',
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

const addActiveMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

describe('RoleSyncEventsRepository — emitRoleAssigned', () => {
  it.effect('inserts a row that findUnprocessed returns', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000001', 'emit-1');
      const team = yield* createTeam('900100000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      const roles = yield* RolesRepository.asEffect();
      const role = yield* roles.insertRole(team.id, 'Coach');

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleAssigned(
        team.id,
        role.id,
        role.name,
        member.id,
        '111111111111111111' as Discord.Snowflake,
      );

      const unprocessed = yield* roleSyncEvents.findUnprocessed(10);
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0]?.team_id).toBe(team.id);
      expect(unprocessed[0]?.role_id).toBe(role.id);
      expect(unprocessed[0]?.event_type).toBe('role_assigned');
      expect(Option.getOrNull(unprocessed[0]?.team_member_id ?? Option.none())).toBe(member.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('inserts nothing when the team cannot be found (the lookupGuildId onNone branch)', () =>
    Effect.gen(function* () {
      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      const nonExistentTeamId = '00000000-0000-0000-0000-0000000000ff' as Team.TeamId;
      const fakeRoleId = '00000000-0000-0000-0000-0000000000fe' as Role.RoleId;
      const fakeMemberId = '00000000-0000-0000-0000-0000000000fd' as TeamMember.TeamMemberId;

      yield* roleSyncEvents.emitRoleAssigned(
        nonExistentTeamId,
        fakeRoleId,
        'Ghost Role',
        fakeMemberId,
        '123' as Discord.Snowflake,
      );

      const unprocessed = yield* roleSyncEvents.findUnprocessed(10);
      expect(unprocessed).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// PR-9, 9b — `Role/MarkEventProcessed` / `Role/MarkEventFailed` also write
// `team_members.last_role_sync_*`, which is what fills `roleSyncState` / `lastRoleSyncAt` /
// `lastRoleSyncError` on `RoleApi.SyncMemberRolesResult` (PR-7's DTO).
describe('RoleSyncEventsRepository — markProcessed / markFailed fidelity fields (9b)', () => {
  const readLastRoleSync = (memberId: TeamMember.TeamMemberId) =>
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) =>
          sql<{
            last_role_sync_at: Date | null;
            last_role_sync_state: string | null;
            last_role_sync_error: string | null;
          }>`SELECT last_role_sync_at, last_role_sync_state, last_role_sync_error FROM team_members WHERE id = ${memberId}`,
      ),
      Effect.map((rows) => rows[0]),
    );

  it.effect('markProcessed writes last_role_sync_state=ok and clears any prior error', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000010', 'fidelity-ok');
      const team = yield* createTeam('900100000000000010' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      const roles = yield* RolesRepository.asEffect();
      const role = yield* roles.insertRole(team.id, 'Coach');

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleAssigned(
        team.id,
        role.id,
        role.name,
        member.id,
        '111111111111111111' as Discord.Snowflake,
      );
      const [event] = yield* roleSyncEvents.findUnprocessed(10);
      if (event === undefined) throw new Error('expected one unprocessed event');

      yield* roleSyncEvents.markProcessed(event.id, DateTime.nowUnsafe());

      const row = yield* readLastRoleSync(member.id);
      expect(row?.last_role_sync_state).toBe('ok');
      expect(row?.last_role_sync_at).not.toBeNull();
      expect(row?.last_role_sync_error).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'markFailed with a terminal error_code writes last_role_sync_state=failed and the code',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('900000000000000011', 'fidelity-failed');
        const team = yield* createTeam('900100000000000011' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        const roles = yield* RolesRepository.asEffect();
        const role = yield* roles.insertRole(team.id, 'Coach');

        const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
        yield* roleSyncEvents.emitRoleAssigned(
          team.id,
          role.id,
          role.name,
          member.id,
          '111111111111111111' as Discord.Snowflake,
        );
        const [event] = yield* roleSyncEvents.findUnprocessed(10);
        if (event === undefined) throw new Error('expected one unprocessed event');

        yield* roleSyncEvents.markFailed(
          event.id,
          'Discord error 50013: Missing Permissions',
          Option.some('captain_action'),
        );

        const row = yield* readLastRoleSync(member.id);
        expect(row?.last_role_sync_state).toBe('failed');
        expect(row?.last_role_sync_error).toBe('captain_action');
        expect(row?.last_role_sync_at).not.toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'markFailed with error_code=None (transient/CC-0) does NOT touch team_members at all',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('900000000000000012', 'fidelity-transient');
        const team = yield* createTeam('900100000000000012' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        const roles = yield* RolesRepository.asEffect();
        const role = yield* roles.insertRole(team.id, 'Coach');

        const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
        yield* roleSyncEvents.emitRoleAssigned(
          team.id,
          role.id,
          role.name,
          member.id,
          '111111111111111111' as Discord.Snowflake,
        );
        const [event] = yield* roleSyncEvents.findUnprocessed(10);
        if (event === undefined) throw new Error('expected one unprocessed event');

        yield* roleSyncEvents.markFailed(event.id, 'HTTP 503: Discord server error', Option.none());

        const row = yield* readLastRoleSync(member.id);
        expect(row?.last_role_sync_state).toBeNull();
        expect(row?.last_role_sync_error).toBeNull();
        expect(row?.last_role_sync_at).toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('markProcessed on a team-scoped event (no team_member_id) does not error', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000013', 'fidelity-team-scoped');
      const team = yield* createTeam('900100000000000013' as Discord.Snowflake, userId);
      const roles = yield* RolesRepository.asEffect();
      const role = yield* roles.insertRole(team.id, 'Coach');

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleCreated(team.id, role.id, role.name);
      const [event] = yield* roleSyncEvents.findUnprocessed(10);
      if (event === undefined) throw new Error('expected one unprocessed event');

      // Must not throw even though there is no team_member_id to update.
      yield* roleSyncEvents.markProcessed(event.id, DateTime.nowUnsafe());
    }).pipe(Effect.provide(TestLayer)),
  );
});

// Should-fix 1 (whole-series review of commit 46806427): `role_sync_events` rows for one member's
// several roles are emitted with no `ORDER BY` guaranteeing a stable order, so which of a
// member's events a `concurrency: 1` drain processes LAST within one poll tick is not meaningful.
// Without a guard, a healthy role's `markProcessed` (`state: 'ok'`) landing after a
// dangerous-permission role's `markFailed` (`state: 'failed'`, `captain_action`) erased the
// failure reason the UI has dedicated copy for.
describe('RoleSyncEventsRepository — markProcessed same-tick guard (should-fix 1)', () => {
  const readLastRoleSync = (memberId: TeamMember.TeamMemberId) =>
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) =>
          sql<{
            last_role_sync_at: Date | null;
            last_role_sync_state: string | null;
            last_role_sync_error: string | null;
          }>`SELECT last_role_sync_at, last_role_sync_state, last_role_sync_error FROM team_members WHERE id = ${memberId}`,
      ),
      Effect.map((rows) => rows[0]),
    );

  it.effect(
    'a same-tick markProcessed (ok) does NOT clobber a same-tick markFailed (failed) recorded moments earlier',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('900000000000000020', 'tick-guard-1');
        const team = yield* createTeam('900100000000000020' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        const roles = yield* RolesRepository.asEffect();
        const dangerousRole = yield* roles.insertRole(team.id, 'Captain');
        const healthyRole = yield* roles.insertRole(team.id, 'Coach');

        const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
        const discordId = '111111111111111111' as Discord.Snowflake;
        yield* roleSyncEvents.emitRoleAssigned(
          team.id,
          dangerousRole.id,
          dangerousRole.name,
          member.id,
          discordId,
        );
        yield* roleSyncEvents.emitRoleAssigned(
          team.id,
          healthyRole.id,
          healthyRole.name,
          member.id,
          discordId,
        );
        const events = yield* roleSyncEvents.findUnprocessed(10);
        const dangerousEvent = events.find((e) => e.role_id === dangerousRole.id);
        const healthyEvent = events.find((e) => e.role_id === healthyRole.id);
        if (dangerousEvent === undefined || healthyEvent === undefined) {
          throw new Error('expected two unprocessed events');
        }

        const tickStartedAt = DateTime.nowUnsafe();

        // The dangerous role's assignment fails first (captain_action)...
        yield* roleSyncEvents.markFailed(
          dangerousEvent.id,
          'Refused to assign Discord role: dangerous permissions',
          Option.some('captain_action'),
        );
        // ...then the healthy role's assignment succeeds, in the SAME tick.
        yield* roleSyncEvents.markProcessed(healthyEvent.id, tickStartedAt);

        const row = yield* readLastRoleSync(member.id);
        expect(row?.last_role_sync_state).toBe('failed');
        expect(row?.last_role_sync_error).toBe('captain_action');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'a markProcessed (ok) from a genuinely NEW tick still clears a stale failure recorded in an earlier tick',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('900000000000000021', 'tick-guard-2');
        const team = yield* createTeam('900100000000000021' as Discord.Snowflake, userId);
        const member = yield* addActiveMember(team.id, userId);
        const roles = yield* RolesRepository.asEffect();
        const role = yield* roles.insertRole(team.id, 'Coach');

        const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
        const discordId = '111111111111111111' as Discord.Snowflake;
        yield* roleSyncEvents.emitRoleAssigned(team.id, role.id, role.name, member.id, discordId);
        const [firstEvent] = yield* roleSyncEvents.findUnprocessed(10);
        if (firstEvent === undefined) throw new Error('expected one unprocessed event');

        // First tick: this role fails.
        yield* roleSyncEvents.markFailed(
          firstEvent.id,
          'Discord error 50013: Missing Permissions',
          Option.some('captain_action'),
        );

        // A captain fixes the permission; the level-based diff re-emits the same assignment.
        yield* roleSyncEvents.emitRoleAssigned(team.id, role.id, role.name, member.id, discordId);
        const events = yield* roleSyncEvents.findUnprocessed(10);
        const secondEvent = events.find((e) => e.id !== firstEvent.id);
        if (secondEvent === undefined) throw new Error('expected a second unprocessed event');

        // Derive the second tick's start from the FIRST tick's own recorded failure timestamp
        // (read back from Postgres) plus a fixed offset, rather than a real-time wait — this
        // cannot be flaky against clock/timestamp rounding between the test process and Postgres,
        // and does not depend on wall-clock delay to prove the guard's direction.
        const afterFirstFailure = yield* readLastRoleSync(member.id);
        if (afterFirstFailure?.last_role_sync_at == null) {
          throw new Error('expected last_role_sync_at to be set after the first failure');
        }
        const secondTickStartedAt = DateTime.add(
          DateTime.fromDateUnsafe(afterFirstFailure.last_role_sync_at),
          { seconds: 1 },
        );
        yield* roleSyncEvents.markProcessed(secondEvent.id, secondTickStartedAt);

        const row = yield* readLastRoleSync(member.id);
        expect(row?.last_role_sync_state).toBe('ok');
        expect(row?.last_role_sync_error).toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe('TeamMembersRepository — findEffectiveRoleIdsForMember', () => {
  it.effect('returns direct and group-inherited roles without duplicates', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000002', 'effective-1');
      const team = yield* createTeam('900200000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);

      const roles = yield* RolesRepository.asEffect();
      const directRole = yield* roles.insertRole(team.id, 'Direct Role');
      const inheritedRole = yield* roles.insertRole(team.id, 'Inherited Role');
      const sharedRole = yield* roles.insertRole(team.id, 'Shared Role');

      // Direct assignment.
      const members = yield* TeamMembersRepository.asEffect();
      yield* members.assignRole(member.id, directRole.id);
      // Also assign the "shared" role directly, AND make it reachable via the group below, to
      // prove the UNION dedupes rather than returning it twice.
      yield* members.assignRole(member.id, sharedRole.id);

      // Group inheritance: member -> child group -> parent group carries the role.
      const groups = yield* GroupsRepository.asEffect();
      const parentGroup = yield* groups.insertGroup(
        team.id,
        'Parent Group',
        Option.none(),
        Option.none(),
        Option.none(),
      );
      const childGroup = yield* groups.insertGroup(
        team.id,
        'Child Group',
        Option.some(parentGroup.id),
        Option.none(),
        Option.none(),
      );
      yield* groups.addMemberById(childGroup.id, member.id);
      yield* roles.assignRoleToGroup(inheritedRole.id, parentGroup.id);
      yield* roles.assignRoleToGroup(sharedRole.id, parentGroup.id);

      const effectiveRoles = yield* members.findEffectiveRoleIdsForMember(member.id);
      const roleIds = effectiveRoles.map((r) => r.role_id).sort();

      expect(roleIds).toStrictEqual([directRole.id, inheritedRole.id, sharedRole.id].sort());
      // sharedRole is reachable via BOTH the direct assignment and the group ancestry — must
      // appear exactly once.
      expect(effectiveRoles.filter((r) => r.role_id === sharedRole.id)).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returns [] for a member with no roles', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000003', 'effective-2');
      const team = yield* createTeam('900300000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);

      const members = yield* TeamMembersRepository.asEffect();
      const effectiveRoles = yield* members.findEffectiveRoleIdsForMember(member.id);

      expect(effectiveRoles).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
