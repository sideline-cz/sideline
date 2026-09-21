// Unit tests for `~/utils/syncGroupRoleMembers.ts`, the shared before/after effective-role
// diff util that `api/group.ts`'s six group-shaped handlers (`assignGroupRole`,
// `unassignGroupRole`, `addGroupMember`, `removeGroupMember`, `moveGroup`, `deleteGroup`) go
// through instead of emitting nothing (the reported bug) or hand-rolling their own diff.
//
// Repositories are stubbed with `Layer.succeed` (no Postgres) — mirrors
// `test/AgeCheckService.test.ts`'s mock-layer style and `test/rcp/role/handleAssigned.test.ts`'s
// call-recording pattern (adapted to server-side `Effect.gen` + `it.effect`, not raw `it`).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
import { Effect, Layer } from 'effect';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import {
  captureGroupRoleSnapshot,
  emitGroupRoleChanges,
  MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION,
  withGroupRoleSync,
} from '~/utils/syncGroupRoleMembers.js';
import { MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER } from '~/utils/syncMemberDiscordRoles.js';

// ---------------------------------------------------------------------------
// Fixture ids
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000900' as Team.TeamId;
const GROUP_ID = '00000000-0000-0000-0000-000000000901' as GroupModel.GroupId;

const memberId = (n: number) =>
  `00000000-0000-0000-0000-0000000009${String(n).padStart(2, '0')}` as TeamMember.TeamMemberId;
const roleId = (n: number) =>
  `00000000-0000-0000-0000-0000000008${String(n).padStart(2, '0')}` as Role.RoleId;
const discordId = (n: number) => String(940000000000000000n + BigInt(n)) as Discord.Snowflake;

const M1 = memberId(1);
const M2 = memberId(2);
const M3 = memberId(3);
const ROLE_A = roleId(1);
const ROLE_B = roleId(2);

// ---------------------------------------------------------------------------
// Mock TeamMembersRepository — a mutable "current effective roles" ground truth that the test
// mutates between capturing the "before" snapshot and triggering the "after" read, plus a
// mutable `member_role_grants` table.
// ---------------------------------------------------------------------------

type RoleRow = { readonly role_id: Role.RoleId; readonly role_name: string };

const makeMembersLayer = (options?: { readonly diesOnFirstCall?: boolean }) => {
  let currentRoles = new Map<TeamMember.TeamMemberId, ReadonlyArray<RoleRow>>();
  let grantedPairs: ReadonlyArray<{
    readonly team_member_id: TeamMember.TeamMemberId;
    readonly role_id: Role.RoleId;
  }> = [];
  let calls = 0;

  const setCurrentRoles = (next: Map<TeamMember.TeamMemberId, ReadonlyArray<RoleRow>>) => {
    currentRoles = next;
  };
  const setGrantedPairs = (
    next: ReadonlyArray<{
      readonly team_member_id: TeamMember.TeamMemberId;
      readonly role_id: Role.RoleId;
    }>,
  ) => {
    grantedPairs = next;
  };

  const layer = Layer.succeed(TeamMembersRepository, {
    findEffectiveRolesForMembers: (memberIds: ReadonlyArray<TeamMember.TeamMemberId>) => {
      calls += 1;
      if (options?.diesOnFirstCall === true && calls === 1) {
        return Effect.die(new Error('simulated DB failure on findEffectiveRolesForMembers'));
      }
      const idSet = new Set(memberIds);
      return Effect.succeed(
        [...currentRoles.entries()]
          .filter(([id]) => idSet.has(id))
          .flatMap(([id, rows]) => rows.map((r) => ({ team_member_id: id, ...r }))),
      );
    },
    findGrantedRolePairsForMembers: (memberIds: ReadonlyArray<TeamMember.TeamMemberId>) => {
      const idSet = new Set(memberIds);
      return Effect.succeed(grantedPairs.filter((p) => idSet.has(p.team_member_id)));
    },
  } as any);

  return { layer, setCurrentRoles, setGrantedPairs, getCallCount: () => calls };
};

// ---------------------------------------------------------------------------
// Mock RoleSyncEventsRepository — records every batch emit call.
// ---------------------------------------------------------------------------

type BatchEntry = {
  readonly eventType: 'role_assigned' | 'role_unassigned';
  readonly roleId: Role.RoleId;
  readonly roleName: string;
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly discordUserId: Discord.Snowflake;
};

const makeRoleSyncEventsLayer = (options?: { readonly diesOnEmit?: boolean }) => {
  const emittedBatches: Array<ReadonlyArray<BatchEntry>> = [];

  const layer = Layer.succeed(RoleSyncEventsRepository, {
    emitRoleEventsBatch: (input: { readonly entries: ReadonlyArray<BatchEntry> }) => {
      if (options?.diesOnEmit === true) {
        return Effect.die(new Error('simulated DB failure on emitRoleEventsBatch'));
      }
      emittedBatches.push(input.entries);
      return Effect.void;
    },
  } as any);

  return { layer, emittedBatches };
};

const withRoles = (...rows: Array<[TeamMember.TeamMemberId, ReadonlyArray<RoleRow>]>) =>
  new Map(rows);

// ===========================================================================
// captureGroupRoleSnapshot + emitGroupRoleChanges — the core diff
// ===========================================================================

describe('syncGroupRoleMembers — gained/lost diff', () => {
  it.effect('gain only: three members each newly gain the same role', () => {
    const targets = [M1, M2, M3].map((id) => ({ teamMemberId: id, discordUserId: discordId(1) }));
    const members = makeMembersLayer();
    const roleSync = makeRoleSyncEventsLayer();

    return Effect.gen(function* () {
      const snapshot = yield* captureGroupRoleSnapshot(targets);
      members.setCurrentRoles(
        withRoles(
          [M1, [{ role_id: ROLE_A, role_name: 'A' }]],
          [M2, [{ role_id: ROLE_A, role_name: 'A' }]],
          [M3, [{ role_id: ROLE_A, role_name: 'A' }]],
        ),
      );
      yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

      expect(roleSync.emittedBatches).toHaveLength(1);
      const entries = roleSync.emittedBatches[0] ?? [];
      expect(entries.filter((e) => e.eventType === 'role_assigned')).toHaveLength(3);
      expect(entries.filter((e) => e.eventType === 'role_unassigned')).toHaveLength(0);
    }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
  });

  it.effect('no change: before equals after → nothing emitted', () => {
    const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
    const members = makeMembersLayer();
    const roleSync = makeRoleSyncEventsLayer();
    members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'A' }]]));

    return Effect.gen(function* () {
      const snapshot = yield* captureGroupRoleSnapshot(targets);
      // Ground truth is unchanged between capture and emit.
      yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

      const allEntries = roleSync.emittedBatches.flat();
      expect(allEntries).toHaveLength(0);
    }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
  });

  it.effect('loss WITH a member_role_grants row is emitted as role_unassigned', () => {
    const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
    const members = makeMembersLayer();
    const roleSync = makeRoleSyncEventsLayer();
    members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'A' }]]));
    members.setGrantedPairs([{ team_member_id: M1, role_id: ROLE_A }]);

    return Effect.gen(function* () {
      const snapshot = yield* captureGroupRoleSnapshot(targets);
      members.setCurrentRoles(withRoles([M1, []]));
      yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

      const allEntries = roleSync.emittedBatches.flat();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]).toMatchObject({
        eventType: 'role_unassigned',
        roleId: ROLE_A,
        teamMemberId: M1,
      });
    }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
  });

  it.effect(
    'loss WITHOUT a member_role_grants row is NOT emitted (the anti-stripping guard)',
    () => {
      const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
      const members = makeMembersLayer();
      const roleSync = makeRoleSyncEventsLayer();
      members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'A' }]]));
      // No grant row for (M1, ROLE_A).

      return Effect.gen(function* () {
        const snapshot = yield* captureGroupRoleSnapshot(targets);
        members.setCurrentRoles(withRoles([M1, []]));
        yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

        expect(roleSync.emittedBatches.flat()).toHaveLength(0);
      }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
    },
  );

  it.effect(
    'still held another way: role present in both before and after → nothing emitted',
    () => {
      const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
      const members = makeMembersLayer();
      const roleSync = makeRoleSyncEventsLayer();
      members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'A' }]]));
      members.setGrantedPairs([{ team_member_id: M1, role_id: ROLE_A }]);

      return Effect.gen(function* () {
        const snapshot = yield* captureGroupRoleSnapshot(targets);
        // The group link was removed, but the member still holds ROLE_A another way (direct
        // assignment, another group, etc.) — ground truth is unchanged.
        yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

        expect(roleSync.emittedBatches.flat()).toHaveLength(0);
      }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
    },
  );

  it.effect('simultaneous gain and loss (the moveGroup shape)', () => {
    const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
    const members = makeMembersLayer();
    const roleSync = makeRoleSyncEventsLayer();
    members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'A' }]]));
    members.setGrantedPairs([{ team_member_id: M1, role_id: ROLE_A }]);

    return Effect.gen(function* () {
      const snapshot = yield* captureGroupRoleSnapshot(targets);
      members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_B, role_name: 'B' }]]));
      yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

      const entries = roleSync.emittedBatches.flat();
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual(
        expect.objectContaining({ eventType: 'role_unassigned', roleId: ROLE_A }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({ eventType: 'role_assigned', roleId: ROLE_B }),
      );
    }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
  });

  it.effect(
    'role name resolution: assign uses the AFTER name, unassign uses the BEFORE name',
    () => {
      const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
      const members = makeMembersLayer();
      const roleSync = makeRoleSyncEventsLayer();
      members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'Old Name' }]]));
      members.setGrantedPairs([{ team_member_id: M1, role_id: ROLE_A }]);

      return Effect.gen(function* () {
        const snapshot = yield* captureGroupRoleSnapshot(targets);
        members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_B, role_name: 'New Name' }]]));
        yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

        const entries = roleSync.emittedBatches.flat();
        const unassigned = entries.find((e) => e.eventType === 'role_unassigned');
        const assigned = entries.find((e) => e.eventType === 'role_assigned');
        expect(unassigned?.roleName).toBe('Old Name');
        expect(assigned?.roleName).toBe('New Name');
      }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
    },
  );

  it.effect('a member without a discord id is dropped and counted as skippedNoDiscordId', () => {
    const targets = [
      { teamMemberId: M1, discordUserId: discordId(1) },
      { teamMemberId: M2, discordUserId: null },
    ];
    const members = makeMembersLayer();

    return Effect.gen(function* () {
      const snapshot = yield* captureGroupRoleSnapshot(targets);
      expect(snapshot.targets).toHaveLength(1);
      expect(snapshot.targets[0]?.teamMemberId).toBe(M1);
      expect(snapshot.skippedNoDiscordId).toBe(1);
    }).pipe(Effect.provide(members.layer));
  });

  it.effect('a member listed twice in targets collapses to one entry', () => {
    const targets = [
      { teamMemberId: M1, discordUserId: discordId(1) },
      { teamMemberId: M1, discordUserId: discordId(1) },
    ];
    const members = makeMembersLayer();
    const roleSync = makeRoleSyncEventsLayer();

    return Effect.gen(function* () {
      const snapshot = yield* captureGroupRoleSnapshot(targets);
      expect(snapshot.targets).toHaveLength(1);

      members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'A' }]]));
      yield* emitGroupRoleChanges(TEAM_ID, snapshot, { groupId: GROUP_ID, operation: 'test' });

      expect(roleSync.emittedBatches.flat()).toHaveLength(1);
    }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
  });
});

// ===========================================================================
// Caps
// ===========================================================================

describe('syncGroupRoleMembers — caps', () => {
  it.effect(
    `per-member cap: ${MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER + 5} gained roles for one member truncate at ${MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER}`,
    () => {
      const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
      const members = makeMembersLayer();
      const roleSync = makeRoleSyncEventsLayer();
      const totalRoles = MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER + 5;

      return Effect.gen(function* () {
        const snapshot = yield* captureGroupRoleSnapshot(targets);
        members.setCurrentRoles(
          withRoles([
            M1,
            Array.from({ length: totalRoles }, (_, i) => ({
              role_id: roleId(100 + i),
              role_name: `Role ${i}`,
            })),
          ]),
        );
        const result = yield* emitGroupRoleChanges(TEAM_ID, snapshot, {
          groupId: GROUP_ID,
          operation: 'test',
        });

        const entries = roleSync.emittedBatches.flat();
        expect(entries).toHaveLength(MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER);
        expect(result.skippedForCap).toBeGreaterThanOrEqual(5);
      }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
    },
  );

  it.effect(
    `global cap (${MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION}): removals are prioritized, but every distinct assign roleId still gets at least one slot`,
    () => {
      const removalCount = MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION + 100;
      const removalTargets = Array.from({ length: removalCount }, (_, i) => ({
        teamMemberId: memberId(200 + i),
        discordUserId: discordId(200 + i),
      }));
      // Two DISTINCT assign roleIds, each wanted by several members — both must survive the cap
      // even though removals alone already exceed it.
      const assignTargetsA = Array.from({ length: 3 }, (_, i) => ({
        teamMemberId: memberId(500 + i),
        discordUserId: discordId(500 + i),
      }));
      const assignTargetsB = Array.from({ length: 3 }, (_, i) => ({
        teamMemberId: memberId(600 + i),
        discordUserId: discordId(600 + i),
      }));
      const targets = [...removalTargets, ...assignTargetsA, ...assignTargetsB];

      const members = makeMembersLayer();
      const roleSync = makeRoleSyncEventsLayer();
      const removeRoleId = roleId(250);
      const beforeMap = new Map<TeamMember.TeamMemberId, ReadonlyArray<RoleRow>>(
        removalTargets.map((t) => [
          t.teamMemberId,
          [{ role_id: removeRoleId, role_name: 'To Remove' }],
        ]),
      );
      members.setCurrentRoles(beforeMap);
      members.setGrantedPairs(
        removalTargets.map((t) => ({ team_member_id: t.teamMemberId, role_id: removeRoleId })),
      );

      return Effect.gen(function* () {
        const snapshot = yield* captureGroupRoleSnapshot(targets);
        const afterMap = new Map<TeamMember.TeamMemberId, ReadonlyArray<RoleRow>>([
          ...removalTargets.map((t): [TeamMember.TeamMemberId, ReadonlyArray<RoleRow>] => [
            t.teamMemberId,
            [],
          ]),
          ...assignTargetsA.map((t): [TeamMember.TeamMemberId, ReadonlyArray<RoleRow>] => [
            t.teamMemberId,
            [{ role_id: roleId(300), role_name: 'Assign A' }],
          ]),
          ...assignTargetsB.map((t): [TeamMember.TeamMemberId, ReadonlyArray<RoleRow>] => [
            t.teamMemberId,
            [{ role_id: roleId(301), role_name: 'Assign B' }],
          ]),
        ]);
        members.setCurrentRoles(afterMap);

        const result = yield* emitGroupRoleChanges(TEAM_ID, snapshot, {
          groupId: GROUP_ID,
          operation: 'test',
        });

        const entries = roleSync.emittedBatches.flat();
        expect(entries.length).toBeLessThanOrEqual(MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION);

        const assignEntries = entries.filter((e) => e.eventType === 'role_assigned');
        const removalEntries = entries.filter((e) => e.eventType === 'role_unassigned');

        // Removals dominate the budget (permission-risk-first)...
        expect(removalEntries.length).toBeGreaterThan(assignEntries.length);
        // ...but BOTH distinct assign roleIds still got at least one slot — the mapping
        // bootstrap for each must never be permanently starved by a removal-heavy operation.
        expect(assignEntries.some((e) => e.roleId === roleId(300))).toBe(true);
        expect(assignEntries.some((e) => e.roleId === roleId(301))).toBe(true);

        expect(result.skippedForCap).toBeGreaterThan(0);
      }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
    },
  );
});

// ===========================================================================
// Best-effort failure handling
// ===========================================================================

describe('syncGroupRoleMembers — best-effort failure handling', () => {
  it.effect('a capture failure is inert: snapshot degrades to empty targets, no throw', () => {
    const targets = [{ teamMemberId: M1, discordUserId: discordId(1) }];
    const members = makeMembersLayer({ diesOnFirstCall: true });

    return Effect.gen(function* () {
      const snapshot = yield* captureGroupRoleSnapshot(targets);
      expect(snapshot.targets).toStrictEqual([]);
    }).pipe(Effect.provide(members.layer));
  });

  it.effect(
    'an emit failure never fails the caller — withGroupRoleSync still returns the write value',
    () => {
      const members = makeMembersLayer();
      const roleSync = makeRoleSyncEventsLayer({ diesOnEmit: true });
      members.setCurrentRoles(withRoles([M1, [{ role_id: ROLE_A, role_name: 'A' }]]));

      return Effect.gen(function* () {
        const result = yield* withGroupRoleSync(
          TEAM_ID,
          Effect.succeed([{ teamMemberId: M1, discordUserId: discordId(1) }]),
          { groupId: GROUP_ID, operation: 'test' },
          Effect.succeed('write-result' as const),
        );
        expect(result).toBe('write-result');
      }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
    },
  );

  it.effect('the write value is passed through unchanged when everything succeeds', () => {
    const members = makeMembersLayer();
    const roleSync = makeRoleSyncEventsLayer();

    return Effect.gen(function* () {
      const result = yield* withGroupRoleSync(
        TEAM_ID,
        Effect.succeed([]),
        { groupId: GROUP_ID, operation: 'test' },
        Effect.succeed(42),
      );
      expect(result).toBe(42);
    }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
  });

  it.effect('a write failure short-circuits: the error propagates and nothing is emitted', () => {
    class BoomError {
      readonly _tag = 'BoomError';
    }
    const members = makeMembersLayer();
    const roleSync = makeRoleSyncEventsLayer();

    return Effect.gen(function* () {
      const outcome = yield* withGroupRoleSync(
        TEAM_ID,
        Effect.succeed([{ teamMemberId: M1, discordUserId: discordId(1) }]),
        { groupId: GROUP_ID, operation: 'test' },
        Effect.fail(new BoomError()),
      ).pipe(Effect.result);

      expect(outcome._tag).toBe('Failure');
      expect(roleSync.emittedBatches.flat()).toHaveLength(0);
    }).pipe(Effect.provide(Layer.merge(members.layer, roleSync.layer)));
  });
});
