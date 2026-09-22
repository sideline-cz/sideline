// Tests for requireReadAccess in applications/server/src/api/permissions.ts.
//
// Behaviour under test:
//   - Non-admin real member     → succeed(realMembership) unchanged
//   - Non-admin non-member      → fail(forbidden)
//   - Global admin non-member   → succeed(synthetic membership with VIEW_PERMISSIONS)
//   - Global admin real member  → succeed(membership with VIEW_PERMISSIONS merged in)
//   - Synthetic membership      → hasPermission guards view/write correctly

import { describe, expect, it } from '@effect/vitest';
import type { Role, Team, TeamMember, User } from '@sideline/domain';
import { Auth as AuthDomain } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { hasPermission, requireReadAccess, VIEW_PERMISSIONS } from '../../src/api/permissions.js';
import type { MembershipWithRole } from '../../src/repositories/TeamMembersRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const USER_ID = '00000000-0000-0000-0000-000000000001' as User.UserId;
const MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const makeCurrentUser = (isGlobalAdmin: boolean): AuthDomain.CurrentUser =>
  new AuthDomain.CurrentUser({
    id: USER_ID,
    discordId: '123456789',
    username: 'testuser',
    avatar: Option.none(),
    isProfileComplete: true,
    name: Option.none(),
    birthDate: Option.none(),
    gender: Option.none(),
    locale: 'en' as const,
    isGlobalAdmin,
    displayName: 'Test User',
  });

const makeRealMembership = (
  permissions: ReadonlyArray<Role.Permission> = ['roster:manage'],
): MembershipWithRole => ({
  id: MEMBER_ID,
  team_id: TEAM_ID,
  user_id: USER_ID,
  active: true,
  role_names: ['Captain'],
  permissions: [...permissions],
  is_profile_complete: true,
  require_complete_profile: Option.none(),
});

// ---------------------------------------------------------------------------
// Mock TeamMembersRepository helper
// ---------------------------------------------------------------------------

type MockMembers = {
  findMembershipByIds: (
    teamId: Team.TeamId,
    userId: User.UserId,
  ) => Effect.Effect<Option.Option<MembershipWithRole>>;
};

const mockMembers = (result: Option.Option<MembershipWithRole>): MockMembers => ({
  findMembershipByIds: (_teamId, _userId) => Effect.succeed(result),
});

// ---------------------------------------------------------------------------
// Helper: run requireReadAccess with a given current user
// ---------------------------------------------------------------------------

const runRequireReadAccess = <E>(
  isGlobalAdmin: boolean,
  membershipResult: Option.Option<MembershipWithRole>,
  forbidden: E,
): Effect.Effect<MembershipWithRole, E> => {
  const currentUser = makeCurrentUser(isGlobalAdmin);
  const members = mockMembers(membershipResult) as any;

  return requireReadAccess(members, TEAM_ID, forbidden).pipe(
    Effect.provideService(AuthDomain.CurrentUserContext, currentUser),
  ) as Effect.Effect<MembershipWithRole, E>;
};

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('requireReadAccess — real member, not global admin', () => {
  it.effect('succeeds with the exact membership object unchanged', () =>
    Effect.gen(function* () {
      const realMembership = makeRealMembership(['roster:manage']);
      const result = yield* runRequireReadAccess(false, Option.some(realMembership), 'forbidden');
      expect(result).toBe(realMembership);
    }),
  );
});

describe('requireReadAccess — non-member, not global admin', () => {
  it.effect('fails with the provided forbidden value', () =>
    Effect.gen(function* () {
      const forbidden = 'ACCESS_DENIED' as const;
      const err = yield* runRequireReadAccess(false, Option.none(), forbidden).pipe(Effect.flip);
      expect(err).toBe(forbidden);
    }),
  );
});

describe('requireReadAccess — non-member, global admin', () => {
  it.effect('succeeds with a synthetic membership containing only VIEW_PERMISSIONS', () =>
    Effect.gen(function* () {
      const result = yield* runRequireReadAccess(true, Option.none(), 'forbidden');
      expect(result.permissions).toEqual(VIEW_PERMISSIONS);
    }),
  );

  it.effect('sets team_id to the requested teamId', () =>
    Effect.gen(function* () {
      const result = yield* runRequireReadAccess(true, Option.none(), 'forbidden');
      expect(result.team_id).toBe(TEAM_ID);
    }),
  );

  it.effect('sets user_id to the current user id', () =>
    Effect.gen(function* () {
      const result = yield* runRequireReadAccess(true, Option.none(), 'forbidden');
      expect(result.user_id).toBe(USER_ID);
    }),
  );

  it.effect('sets active to true', () =>
    Effect.gen(function* () {
      const result = yield* runRequireReadAccess(true, Option.none(), 'forbidden');
      expect(result.active).toBe(true);
    }),
  );

  it.effect('sets id to the nil-UUID sentinel', () =>
    Effect.gen(function* () {
      const result = yield* runRequireReadAccess(true, Option.none(), 'forbidden');
      expect(result.id).toBe(NIL_UUID);
    }),
  );
});

describe('requireReadAccess — real member, global admin', () => {
  it.effect('includes both real permissions and all VIEW_PERMISSIONS', () =>
    Effect.gen(function* () {
      const realMembership = makeRealMembership(['roster:manage']);
      const result = yield* runRequireReadAccess(true, Option.some(realMembership), 'forbidden');
      // Must retain the original membership id
      expect(result.id).toBe(realMembership.id);
      // Must retain the real permission
      expect(result.permissions).toContain('roster:manage');
      // Must include all VIEW_PERMISSIONS
      for (const perm of VIEW_PERMISSIONS) {
        expect(result.permissions).toContain(perm);
      }
    }),
  );
});

describe('requireReadAccess — write-path guard via hasPermission', () => {
  it.effect('synthetic membership: hasPermission returns false for write permission', () =>
    Effect.gen(function* () {
      const membership = yield* runRequireReadAccess(true, Option.none(), 'forbidden');
      expect(hasPermission(membership, 'roster:manage')).toBe(false);
    }),
  );

  it.effect('synthetic membership: hasPermission returns true for view permission', () =>
    Effect.gen(function* () {
      const membership = yield* runRequireReadAccess(true, Option.none(), 'forbidden');
      expect(hasPermission(membership, 'roster:view')).toBe(true);
    }),
  );
});
