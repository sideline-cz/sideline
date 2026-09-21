// TDD mode — tests for AgeCheckService.evaluate() with gender-based assignment.
// These tests will FAIL until Phase 5 implements:
//   - AgeThresholdRepository.getMembersForAutoAssignment (renamed from getMembersWithBirthDates,
//     now includes gender field and drops the SQL WHERE birth_date IS NOT NULL filter)
//   - AgeCheckService detectChanges() updated with Option-aware ageOk + genderOk logic
//   - Notification copy softened to "automatic group rules"

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const GROUP_ID_BOYS = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const GROUP_ID_GIRLS = '00000000-0000-0000-0000-000000000031' as GroupModel.GroupId;
const GROUP_ID_REQUIRED = '00000000-0000-0000-0000-000000000032' as GroupModel.GroupId;
const MEMBER_ID_1 = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const USER_ID_1 = '00000000-0000-0000-0000-000000000001' as User.UserId;
const DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const ROLE_ID_YOUTH = '00000000-0000-0000-0000-000000000040' as Role.RoleId;

// Today: 2026-05-11 (from project context)
const TODAY = new Date('2026-05-11T12:00:00Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRule = (overrides: {
  group_id?: GroupModel.GroupId;
  min_age?: Option.Option<number>;
  max_age?: Option.Option<number>;
  gender?: Option.Option<User.Gender>;
  required_group_id?: Option.Option<GroupModel.GroupId>;
}) => ({
  id: 'rule-001' as any,
  team_id: TEAM_ID,
  group_id: overrides.group_id ?? GROUP_ID_BOYS,
  group_name: 'U12 Boys',
  min_age: overrides.min_age ?? Option.none(),
  max_age: overrides.max_age ?? Option.none(),
  gender: overrides.gender ?? Option.none(),
  required_group_id: overrides.required_group_id ?? Option.none(),
});

const makeMember = (overrides: {
  member_id?: TeamMember.TeamMemberId;
  birth_date?: Option.Option<string>;
  gender?: Option.Option<User.Gender>;
  group_ids?: string[];
}) => ({
  member_id: overrides.member_id ?? MEMBER_ID_1,
  user_id: USER_ID_1,
  member_name: Option.some('Test Player'),
  username: 'testplayer',
  discord_id: DISCORD_ID,
  birth_date: overrides.birth_date ?? Option.none(),
  gender: overrides.gender ?? Option.none(),
  is_admin: false,
  group_ids: overrides.group_ids ?? [],
});

// ---------------------------------------------------------------------------
// Call capture stores
// ---------------------------------------------------------------------------

let addedCalls: Array<{ groupId: GroupModel.GroupId; memberId: TeamMember.TeamMemberId }>;
let removedCalls: Array<{ groupId: GroupModel.GroupId; memberId: TeamMember.TeamMemberId }>;
let notificationInsertCalls: Array<{ content: string; type: string }>;
// Captures every call AgeCheckService makes to any role-sync-shaped emit method.
let roleSyncCalls: Array<{ method: string; args: unknown[] }>;

type EmittedRoleSyncEntry = {
  readonly eventType: 'role_assigned' | 'role_unassigned';
  readonly roleId: Role.RoleId;
  readonly roleName: string;
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly discordUserId: Discord.Snowflake;
};
// Every `emitRoleEventsBatch` call's `entries`, typed (unlike `roleSyncCalls` above, which exists
// only to assert "some role-sync call happened" without depending on the exact shape) — used by
// the tests under "group-role Discord sync" below to assert the actual `eventType`/`roleId`/
// `teamMemberId` emitted, not just that SOME call fired (see blocker 4 of the
// `fix/group-role-discord-sync` review: the earlier version of these tests mocked
// `getRolesForGroup` to always return `[]`, so they passed even when production code did nothing).
let emittedBatches: Array<ReadonlyArray<EmittedRoleSyncEntry>>;

// Backing "ground truth" for the `TeamMembersRepository` mock's `findEffectiveRolesForMembers`.
// `captureGroupRoleSnapshot` (called BEFORE `commitChanges`) reads `beforeRoles`;
// `GroupsRepository.addMemberById`/`removeMemberById` (the write) flip `currentRoles` over to
// `afterRoles` the moment the first group-membership change commits; `emitGroupRoleChanges`
// (called AFTER `commitChanges`) then reads `afterRoles` — mirroring the real BEFORE/write/AFTER
// ordering `AgeCheckService.evaluateTeam` enforces.
type RoleRow = { readonly role_id: Role.RoleId; readonly role_name: string };
let beforeRoles: Map<TeamMember.TeamMemberId, ReadonlyArray<RoleRow>>;
let afterRoles: Map<TeamMember.TeamMemberId, ReadonlyArray<RoleRow>>;
let currentRoles: Map<TeamMember.TeamMemberId, ReadonlyArray<RoleRow>>;
let grantedPairs: Array<{
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly role_id: Role.RoleId;
}>;

const resetStores = () => {
  addedCalls = [];
  removedCalls = [];
  notificationInsertCalls = [];
  roleSyncCalls = [];
  emittedBatches = [];
  beforeRoles = new Map();
  afterRoles = new Map();
  currentRoles = beforeRoles;
  grantedPairs = [];
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockAgeThresholdRepositoryLayer = (overrides: {
  rules?: ReturnType<typeof makeRule>[];
  members?: ReturnType<typeof makeMember>[];
}) =>
  Layer.succeed(AgeThresholdRepository, {
    findRulesByTeamId: () => Effect.succeed(overrides.rules ?? []),
    getMembersForAutoAssignment: () => Effect.succeed(overrides.members ?? []),
    findRuleById: () => Effect.succeed(Option.none()),
    insertRule: () => Effect.die(new Error('Not implemented')),
    updateRuleById: () => Effect.die(new Error('Not implemented')),
    deleteRuleById: () => Effect.void,
    getAllTeamsWithRules: () => Effect.succeed([]),
  } as any);

const makeMockGroupsRepositoryLayer = () =>
  Layer.succeed(GroupsRepository, {
    addMemberById: (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) => {
      addedCalls.push({ groupId, memberId });
      currentRoles = afterRoles;
      return Effect.void;
    },
    removeMemberById: (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) => {
      removedCalls.push({ groupId, memberId });
      currentRoles = afterRoles;
      return Effect.void;
    },
    findGroupsByTeamId: () => Effect.succeed([]),
    findGroupById: () => Effect.succeed(Option.none()),
    insertGroup: () => Effect.die(new Error('Not implemented')),
    updateGroupById: () => Effect.die(new Error('Not implemented')),
    archiveGroupById: () => Effect.void,
    moveGroup: () => Effect.die(new Error('Not implemented')),
    findMembersByGroupId: () => Effect.succeed([]),
    getRolesForGroup: () => Effect.succeed([]),
    getMemberCount: () => Effect.succeed(0),
    getChildren: () => Effect.succeed([]),
    getAncestorIds: () => Effect.succeed([]),
    getDescendantMemberIds: () => Effect.succeed([]),
  } as any);

const makeMockNotificationsRepositoryLayer = () =>
  Layer.succeed(NotificationsRepository, {
    insert: (
      _teamId: Team.TeamId,
      _userId: User.UserId,
      type: string,
      _title: string,
      body: string,
    ) => {
      notificationInsertCalls.push({ content: body, type });
      return Effect.void;
    },
    insertBulk: (notifications: Array<{ type: string; body: string }>) => {
      for (const n of notifications) {
        notificationInsertCalls.push({ content: n.body, type: n.type });
      }
      return Effect.void;
    },
    findByUserId: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findById: () => Effect.succeed(Option.none()),
    findOneById: () => Effect.succeed(Option.none()),
    markAsRead: () => Effect.void,
    markAllAsRead: () => Effect.void,
    insertOne: () => Effect.die(new Error('Not implemented')),
    markOneAsRead: () => Effect.void,
    markAllRead: () => Effect.void,
  } as any);

const makeMockChannelSyncEventsRepositoryLayer = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    emitMemberAdded: () => Effect.void,
    emitMemberRemoved: () => Effect.void,
    emitChannelCreated: () => Effect.void,
    emitChannelDeleted: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as any);

const makeMockRoleSyncEventsRepositoryLayer = () =>
  Layer.succeed(RoleSyncEventsRepository, {
    emitRoleCreated: (...args: unknown[]) => {
      roleSyncCalls.push({ method: 'emitRoleCreated', args });
      return Effect.void;
    },
    emitRoleDeleted: (...args: unknown[]) => {
      roleSyncCalls.push({ method: 'emitRoleDeleted', args });
      return Effect.void;
    },
    emitRoleAssigned: (...args: unknown[]) => {
      roleSyncCalls.push({ method: 'emitRoleAssigned', args });
      return Effect.void;
    },
    emitRoleUnassigned: (...args: unknown[]) => {
      roleSyncCalls.push({ method: 'emitRoleUnassigned', args });
      return Effect.void;
    },
    emitRoleEventsBatch: (input: {
      readonly teamId: Team.TeamId;
      readonly entries: ReadonlyArray<EmittedRoleSyncEntry>;
    }) => {
      roleSyncCalls.push({ method: 'emitRoleEventsBatch', args: [input] });
      emittedBatches.push(input.entries);
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

// `fix/group-role-discord-sync`: `AgeCheckService` now routes its role-sync emission through the
// shared `captureGroupRoleSnapshot` / `emitGroupRoleChanges` diff (`utils/syncGroupRoleMembers.ts`),
// which requires `TeamMembersRepository` for its before/after effective-roles reads and its
// `member_role_grants` anti-stripping gate. This mock backs both with the mutable
// `beforeRoles` / `currentRoles` / `afterRoles` / `grantedPairs` state declared above — adding it
// here required no change to any other test body in this file (see the review's blocker 1: the
// same pattern already applies to `RoleSyncEventsRepository` above).
const makeMockTeamMembersRepositoryLayer = () =>
  Layer.succeed(TeamMembersRepository, {
    findEffectiveRolesForMembers: (memberIds: ReadonlyArray<TeamMember.TeamMemberId>) => {
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

const buildTestLayer = (overrides: {
  rules?: ReturnType<typeof makeRule>[];
  members?: ReturnType<typeof makeMember>[];
}) =>
  AgeCheckService.Default.pipe(
    Layer.provide(makeMockAgeThresholdRepositoryLayer(overrides)),
    Layer.provide(makeMockGroupsRepositoryLayer()),
    Layer.provide(makeMockNotificationsRepositoryLayer()),
    Layer.provide(makeMockChannelSyncEventsRepositoryLayer()),
    Layer.provide(makeMockRoleSyncEventsRepositoryLayer()),
    Layer.provide(makeMockTeamMembersRepositoryLayer()),
  );

const runEvaluate = (overrides: {
  rules?: ReturnType<typeof makeRule>[];
  members?: ReturnType<typeof makeMember>[];
}) =>
  AgeCheckService.asEffect().pipe(
    Effect.flatMap((svc) => svc.evaluate(TEAM_ID, TODAY)),
    Effect.provide(buildTestLayer(overrides)),
  );

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('AgeCheckService.evaluate — age-only rules', () => {
  // Test case 1: Age-only rule (min=10, max=14), member age 12, gender male → added
  it.effect('age-only rule: member age 12 (in range) → added change', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    // DOB for age 12 on 2026-05-11: born 2014-01-01 → age 12
    const member = makeMember({
      birth_date: Option.some('2014-01-01'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_BOYS);
          expect(addedCalls[0].memberId).toBe(MEMBER_ID_1);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Test case 2: Age-only rule (min=10, max=14), member age 9 → no change
  it.effect('age-only rule: member age 9 (below min) → no change', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    // DOB for age 9 on 2026-05-11: born 2017-01-01 → age 9
    const member = makeMember({
      birth_date: Option.some('2017-01-01'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
          expect(removedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Test case 3: Age-only rule (min=10, max=14), member age 15 → no change
  it.effect('age-only rule: member age 15 (above max) → no change', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    // DOB for age 15 on 2026-05-11: born 2011-01-01 → age 15
    const member = makeMember({
      birth_date: Option.some('2011-01-01'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
          expect(removedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Test case 4: Age-only rule, member with birth_date = None → no change (regression)
  // Critical: dropping SQL WHERE filter must not cause null birth dates to silently match
  it.effect(
    'age-only rule: member with birth_date=None → no change (null-safety regression)',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      const member = makeMember({ birth_date: Option.none(), gender: Option.some('male') });

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(0);
            expect(addedCalls).toHaveLength(0);
            expect(removedCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

describe('AgeCheckService.evaluate — gender-only rules', () => {
  // Test case 5: Gender-only rule (gender=female), member with no birth date, gender=female → added
  it.effect('gender-only rule: female member with no birth date → added', () => {
    const rule = makeRule({ group_id: GROUP_ID_GIRLS, gender: Option.some('female') });
    const member = makeMember({ birth_date: Option.none(), gender: Option.some('female') });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_GIRLS);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Test case 6: Gender-only rule (gender=female), member with gender=None → no change
  it.effect('gender-only rule: member with gender=None → no change', () => {
    const rule = makeRule({ group_id: GROUP_ID_GIRLS, gender: Option.some('female') });
    const member = makeMember({ birth_date: Option.none(), gender: Option.none() });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Test case 7: Gender-only rule (gender=male), member with gender=female → no change
  it.effect('gender-only rule: gender mismatch (male rule, female member) → no change', () => {
    const rule = makeRule({ gender: Option.some('male') });
    const member = makeMember({ birth_date: Option.none(), gender: Option.some('female') });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });
});

describe('AgeCheckService.evaluate — combined age + gender rules (AND semantics)', () => {
  // Test case 8: Combined age + gender (min=10, max=14, gender=female) — exhaustive 2x2 matrix
  it.effect('combined rule: female age 12 → added', () => {
    const rule = makeRule({
      group_id: GROUP_ID_GIRLS,
      min_age: Option.some(10),
      max_age: Option.some(14),
      gender: Option.some('female'),
    });
    const member = makeMember({
      birth_date: Option.some('2014-01-01'),
      gender: Option.some('female'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_GIRLS);
          expect(addedCalls[0].memberId).toBe(MEMBER_ID_1);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('combined rule: male age 12 → no change (gender mismatch)', () => {
    const rule = makeRule({
      group_id: GROUP_ID_GIRLS,
      min_age: Option.some(10),
      max_age: Option.some(14),
      gender: Option.some('female'),
    });
    const member = makeMember({
      birth_date: Option.some('2014-01-01'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('combined rule: female age 9 → no change (age out of range)', () => {
    const rule = makeRule({
      group_id: GROUP_ID_GIRLS,
      min_age: Option.some(10),
      max_age: Option.some(14),
      gender: Option.some('female'),
    });
    const member = makeMember({
      birth_date: Option.some('2017-01-01'),
      gender: Option.some('female'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('combined rule: male age 9 → no change (both criteria fail)', () => {
    const rule = makeRule({
      group_id: GROUP_ID_GIRLS,
      min_age: Option.some(10),
      max_age: Option.some(14),
      gender: Option.some('female'),
    });
    const member = makeMember({
      birth_date: Option.some('2017-01-01'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });
});

describe('AgeCheckService.evaluate — idempotency and removal', () => {
  // Test case 9: Member already in target group, rule still satisfied → no added change
  it.effect('member already in group and rule satisfied → no change (idempotent)', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    const member = makeMember({
      birth_date: Option.some('2014-01-01'),
      gender: Option.some('male'),
      group_ids: [GROUP_ID_BOYS], // already in the group
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
          expect(removedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Test case 10: Member in target group, rule no longer satisfied → removed change
  it.effect('member in group but rule no longer satisfied → removed change', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    // Age 15 — above max, but already in group
    const member = makeMember({
      birth_date: Option.some('2011-01-01'),
      gender: Option.some('male'),
      group_ids: [GROUP_ID_BOYS], // currently in the group
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('removed');
          expect(removedCalls).toHaveLength(1);
          expect(removedCalls[0].groupId).toBe(GROUP_ID_BOYS);
          expect(removedCalls[0].memberId).toBe(MEMBER_ID_1);
        }),
      ),
      Effect.asVoid,
    );
  });
});

describe('AgeCheckService.evaluate — boundary conditions', () => {
  // Test case 11: Boundary — member exactly at min age (DOB exactly today - min years) → inclusive >= passes
  it.effect('boundary: member exactly at min age today (inclusive >=) → matches', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    // Age exactly 10 on 2026-05-11: DOB = 2016-05-11
    const member = makeMember({
      birth_date: Option.some('2016-05-11'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_BOYS);
          expect(addedCalls[0].memberId).toBe(MEMBER_ID_1);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Test case 12: Boundary — member exactly at max age → inclusive <= passes
  it.effect('boundary: member exactly at max age today (inclusive <=) → matches', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    // Age exactly 14 on 2026-05-11: DOB = 2012-05-11
    const member = makeMember({
      birth_date: Option.some('2012-05-11'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_BOYS);
          expect(addedCalls[0].memberId).toBe(MEMBER_ID_1);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Day-boundary triad — min bound
  // DOB 2016-05-10: turned 10 yesterday → age 10 → matches
  it.effect('day boundary: DOB one day before min birthday (turned 10 yesterday) → matches', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    const member = makeMember({
      birth_date: Option.some('2016-05-10'),
      gender: Option.some('male'),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
        }),
      ),
      Effect.asVoid,
    );
  });

  // DOB 2016-05-12: turns 10 tomorrow → still age 9 → no match
  it.effect(
    'day boundary: DOB one day after min birthday (turns 10 tomorrow → age 9) → no match',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      const member = makeMember({
        birth_date: Option.some('2016-05-12'),
        gender: Option.some('male'),
      });

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(0);
            expect(addedCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  // Day-boundary triad — max bound
  // DOB 2011-05-12: turns 15 tomorrow → still age 14 → matches
  it.effect(
    'day boundary: DOB one day after max birthday (turns 15 tomorrow → still 14) → matches',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      const member = makeMember({
        birth_date: Option.some('2011-05-12'),
        gender: Option.some('male'),
      });

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(1);
            expect(changes[0].action).toBe('added');
            expect(addedCalls).toHaveLength(1);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  // DOB 2011-05-11: turns 15 today → age 15 → exceeds max of 14 → no match
  it.effect(
    'day boundary: DOB exactly at max+1 birthday (turns 15 today → age 15) → no match',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      const member = makeMember({
        birth_date: Option.some('2011-05-11'),
        gender: Option.some('male'),
      });

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(0);
            expect(addedCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

describe('AgeCheckService.evaluate — required-group rules', () => {
  // Case 1: required-group-only rule, member in that group → 'added'
  it.effect('required-group-only rule: member in required group → added', () => {
    const rule = makeRule({ required_group_id: Option.some(GROUP_ID_REQUIRED) });
    const member = makeMember({
      group_ids: [GROUP_ID_REQUIRED],
      birth_date: Option.none(),
      gender: Option.none(),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_BOYS);
          expect(addedCalls[0].memberId).toBe(MEMBER_ID_1);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Case 2: required-group-only rule, member NOT in that group → no change
  it.effect('required-group-only rule: member not in required group → no change', () => {
    const rule = makeRule({ required_group_id: Option.some(GROUP_ID_REQUIRED) });
    const member = makeMember({
      group_ids: [],
      birth_date: Option.none(),
      gender: Option.none(),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
          expect(removedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Case 3: required-group + gender combined, member meets both → 'added'
  it.effect('required-group + gender combined: female member in required group → added', () => {
    const rule = makeRule({
      group_id: GROUP_ID_GIRLS,
      gender: Option.some('female'),
      required_group_id: Option.some(GROUP_ID_REQUIRED),
    });
    const member = makeMember({
      gender: Option.some('female'),
      group_ids: [GROUP_ID_REQUIRED],
      birth_date: Option.none(),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_GIRLS);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Case 4: required-group + gender combined, gender mismatch → no change
  it.effect(
    'required-group + gender combined: male member in required group (gender mismatch) → no change',
    () => {
      const rule = makeRule({
        group_id: GROUP_ID_GIRLS,
        gender: Option.some('female'),
        required_group_id: Option.some(GROUP_ID_REQUIRED),
      });
      const member = makeMember({
        gender: Option.some('male'),
        group_ids: [GROUP_ID_REQUIRED],
        birth_date: Option.none(),
      });

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(0);
            expect(addedCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  // Case 5: required-group + gender combined, not in required group → no change
  it.effect(
    'required-group + gender combined: female member not in required group → no change',
    () => {
      const rule = makeRule({
        group_id: GROUP_ID_GIRLS,
        gender: Option.some('female'),
        required_group_id: Option.some(GROUP_ID_REQUIRED),
      });
      const member = makeMember({
        gender: Option.some('female'),
        group_ids: [],
        birth_date: Option.none(),
      });

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(0);
            expect(addedCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  // Case 6: required-group + age combined, member matches both → 'added'
  it.effect('required-group + age combined: age 12 in required group → added', () => {
    const rule = makeRule({
      min_age: Option.some(10),
      max_age: Option.some(14),
      required_group_id: Option.some(GROUP_ID_REQUIRED),
    });
    // DOB for age 12 on 2026-05-11: born 2014-01-01
    const member = makeMember({
      birth_date: Option.some('2014-01-01'),
      group_ids: [GROUP_ID_REQUIRED],
      gender: Option.none(),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          expect(addedCalls).toHaveLength(1);
          expect(addedCalls[0].groupId).toBe(GROUP_ID_BOYS);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Case 7: Member already in target group AND in required group AND rule still satisfied → no change (idempotency)
  it.effect('idempotency: member already in target group AND in required group → no change', () => {
    const rule = makeRule({ required_group_id: Option.some(GROUP_ID_REQUIRED) });
    const member = makeMember({
      group_ids: [GROUP_ID_REQUIRED, GROUP_ID_BOYS], // already in both groups
      birth_date: Option.none(),
      gender: Option.none(),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(0);
          expect(addedCalls).toHaveLength(0);
          expect(removedCalls).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  // Case 8: Member in target group but NOT in required group → 'removed'
  it.effect('removal: member in target group but not in required group → removed', () => {
    const rule = makeRule({ required_group_id: Option.some(GROUP_ID_REQUIRED) });
    const member = makeMember({
      group_ids: [GROUP_ID_BOYS], // in target group but missing required group
      birth_date: Option.none(),
      gender: Option.none(),
    });

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('removed');
          expect(removedCalls).toHaveLength(1);
          expect(removedCalls[0].groupId).toBe(GROUP_ID_BOYS);
          expect(removedCalls[0].memberId).toBe(MEMBER_ID_1);
        }),
      ),
      Effect.asVoid,
    );
  });
});

describe('AgeCheckService.evaluate — notification copy', () => {
  // Test case 13a: Member-facing notification (insert) uses neutral wording for 'added'
  it.effect(
    'added: member-facing notification contains "automatic group rules" not "age threshold"',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      // Non-admin member — only the member-facing insert() path fires
      const member = makeMember({
        birth_date: Option.some('2014-01-01'),
        gender: Option.some('male'),
        // is_admin defaults to false
      });

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((_changes) =>
          Effect.sync(() => {
            // At least one insert() call should fire for the member-facing notification
            expect(notificationInsertCalls.length).toBeGreaterThan(0);
            const memberNotification = notificationInsertCalls.find((n) =>
              /automatic group rules/i.test(n.content),
            );
            expect(memberNotification).toBeDefined();
            // None of the notifications should use legacy "age threshold" wording
            const legacyWording = notificationInsertCalls.find((n) =>
              /age threshold/i.test(n.content),
            );
            expect(legacyWording).toBeUndefined();
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  // Test case 13b: Admin bulk notification (insertBulk) also uses neutral wording for 'added'
  it.effect(
    'added: admin bulk notification contains "automatic group rules" not "age threshold"',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      // Admin member — both the member-facing insert() and admin insertBulk() paths fire
      const adminMember = {
        ...makeMember({
          birth_date: Option.some('2014-01-01'),
          gender: Option.some('male'),
        }),
        is_admin: true,
      };

      return runEvaluate({ rules: [rule], members: [adminMember] }).pipe(
        Effect.tap((_changes) =>
          Effect.sync(() => {
            // With an admin, at least 2 notifications should fire (member + admin bulk)
            expect(notificationInsertCalls.length).toBeGreaterThanOrEqual(2);
            // Every captured notification body must avoid legacy "age threshold" wording
            for (const n of notificationInsertCalls) {
              expect(n.content).not.toMatch(/age threshold/i);
            }
            // At least one notification must carry "automatic group rules"
            const withNeutralWording = notificationInsertCalls.filter((n) =>
              /automatic group rules/i.test(n.content),
            );
            expect(withNeutralWording.length).toBeGreaterThan(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  // Test case 13c: 'removed' path — admin notification also uses neutral wording
  it.effect(
    'removed: admin bulk notification contains "automatic group rules" not "age threshold"',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      // Age 15 — above max, currently in group → removal
      const adminMember = {
        ...makeMember({
          birth_date: Option.some('2011-01-01'),
          gender: Option.some('male'),
          group_ids: [GROUP_ID_BOYS], // already in group
        }),
        is_admin: true,
      };

      return runEvaluate({ rules: [rule], members: [adminMember] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(1);
            expect(changes[0].action).toBe('removed');
            // At least one notification should fire
            expect(notificationInsertCalls.length).toBeGreaterThan(0);
            // Every notification body must avoid legacy "age threshold" wording
            for (const n of notificationInsertCalls) {
              expect(n.content).not.toMatch(/age threshold/i);
            }
            // At least one notification must carry "automatic group rules"
            const withNeutralWording = notificationInsertCalls.filter((n) =>
              /automatic group rules/i.test(n.content),
            );
            expect(withNeutralWording.length).toBeGreaterThan(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Regression tests for `fix/group-role-discord-sync` (decision 5: AgeCheckService is in scope).
// `AgeCheckService.ts`'s `commitChange` used to call `groups.addMemberById` / `removeMemberById`
// directly with no role-sync emission at all — unlike the HTTP `addGroupMember` /
// `removeGroupMember` handlers, the automatic age-based path had no equivalent. The removal
// direction in particular was a live permissions leak: a member who aged out of a group kept
// that group's Discord role forever, because nothing ever told the bot to take it away.
//
// `AgeCheckService` now routes through the shared before/after diff (`syncGroupRoleMembers.ts`),
// so these tests assert the actual emitted `entries` (`eventType` / `roleId` / `teamMemberId`),
// not just "some call happened" — see the review's blocker 4: the previous version of these tests
// mocked `getRolesForGroup` to always return `[]`, making `entries` always `[]` and passing
// regardless of what production code did.
// ---------------------------------------------------------------------------

describe('AgeCheckService.evaluate — group-role Discord sync (fix/group-role-discord-sync)', () => {
  it.effect('automatic age-based group ADD emits role_assigned for the gained role', () => {
    const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
    const member = makeMember({
      birth_date: Option.some('2014-01-01'),
      gender: Option.some('male'),
    });
    // Before: member holds no roles. After the group add commits, they gain `Youth` — attached
    // to `GROUP_ID_BOYS`, the group this rule adds them to.
    beforeRoles.set(MEMBER_ID_1, []);
    afterRoles.set(MEMBER_ID_1, [{ role_id: ROLE_ID_YOUTH, role_name: 'Youth' }]);

    return runEvaluate({ rules: [rule], members: [member] }).pipe(
      Effect.tap((changes) =>
        Effect.sync(() => {
          expect(changes).toHaveLength(1);
          expect(changes[0].action).toBe('added');
          const entries = emittedBatches.flat();
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            eventType: 'role_assigned',
            roleId: ROLE_ID_YOUTH,
            teamMemberId: MEMBER_ID_1,
          });
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect(
    'automatic age-based group REMOVE emits role_unassigned for the lost role (the permissions-leak regression)',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      // Age 15 — above max, but already in the group (ages out this evaluation).
      const member = makeMember({
        birth_date: Option.some('2011-01-01'),
        gender: Option.some('male'),
        group_ids: [GROUP_ID_BOYS],
      });
      // Before: member holds `Youth` (granted via `member_role_grants`, so the anti-stripping
      // gate does not block the removal). After the group remove commits, they hold nothing.
      beforeRoles.set(MEMBER_ID_1, [{ role_id: ROLE_ID_YOUTH, role_name: 'Youth' }]);
      grantedPairs = [{ team_member_id: MEMBER_ID_1, role_id: ROLE_ID_YOUTH }];
      afterRoles.set(MEMBER_ID_1, []);

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(1);
            expect(changes[0].action).toBe('removed');
            const entries = emittedBatches.flat();
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({
              eventType: 'role_unassigned',
              roleId: ROLE_ID_YOUTH,
              teamMemberId: MEMBER_ID_1,
            });
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'member ages out of group A but still holds the role via group B → no role_unassigned',
    () => {
      const rule = makeRule({ min_age: Option.some(10), max_age: Option.some(14) });
      // Age 15 — above max, ages out of `GROUP_ID_BOYS` this evaluation. Also a member of
      // `GROUP_ID_GIRLS` (standing in for a second group, e.g. "Juniors") which independently
      // grants the SAME role — `GROUP_ID_GIRLS` carries no rule here, so it is untouched by
      // `detectChanges` and the member stays in it across this evaluation.
      const member = makeMember({
        birth_date: Option.some('2011-01-01'),
        gender: Option.some('male'),
        group_ids: [GROUP_ID_BOYS, GROUP_ID_GIRLS],
      });
      // Before AND after: member holds `Youth` — lost from `GROUP_ID_BOYS`, but still granted
      // through `GROUP_ID_GIRLS`, so the ground truth is unchanged by this evaluation's write.
      beforeRoles.set(MEMBER_ID_1, [{ role_id: ROLE_ID_YOUTH, role_name: 'Youth' }]);
      grantedPairs = [{ team_member_id: MEMBER_ID_1, role_id: ROLE_ID_YOUTH }];
      afterRoles.set(MEMBER_ID_1, [{ role_id: ROLE_ID_YOUTH, role_name: 'Youth' }]);

      return runEvaluate({ rules: [rule], members: [member] }).pipe(
        Effect.tap((changes) =>
          Effect.sync(() => {
            expect(changes).toHaveLength(1);
            expect(changes[0].action).toBe('removed');
            // The role is still held (via `GROUP_ID_GIRLS`) — the shared diff must not strip it.
            expect(emittedBatches.flat()).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});
