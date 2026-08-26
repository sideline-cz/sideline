import type { Auth, Role, Team, TeamMember, User } from '@sideline/domain';
import { ALL_PACKAGES } from '@sideline/rules/content';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import type { RulesLeaderboardRow } from '~/api/rules-trainer.js';
import { buildRulesLeaderboardResponse } from '~/api/rules-trainer.js';
import { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';

// A real scenario id from the actual content, so `packageMastery` (which
// only credits outcomes present in a package's roster) counts it — a made-up
// id would silently score as strength 0, defeating the fixture's purpose.
const REAL_SCENARIO_ID: string = (() => {
  const firstScenario = ALL_PACKAGES[0]?.scenarios[0];
  if (firstScenario === undefined) {
    throw new Error('ALL_PACKAGES[0] has no scenarios — fixture assumption broken');
  }
  return firstScenario.id;
})();

/**
 * Unit coverage for `getRulesLeaderboard`'s visibility rule (Phase 3a of
 * `docs/plans/rules-trainer.md`) — exercised directly against
 * `buildRulesLeaderboardResponse` rather than a full `ApiLive` HTTP round
 * trip (see `LeaderboardApiLive`/`getLeaderboard`, which has no such test
 * either): the function is pure given its three inputs (rows, currentUser,
 * membership), and the auth-chain gate (`requireMembership`) is already
 * covered generically by `test/api/permissions.test.ts`. This isolates the
 * one thing that is genuinely new and easy to get backwards: ranking
 * happens BEFORE the visibility filter, so a plain member's single visible
 * entry still carries their TRUE team rank.
 */

const TEST_TEAM_ID = '00000000-0000-4000-b000-000000000010' as Team.TeamId;

const MANAGER_MEMBER_ID = '00000000-0000-4000-c000-000000000001' as TeamMember.TeamMemberId;
const MANAGER_USER_ID = '00000000-0000-4000-a000-000000000001' as User.UserId;

const PLAYER_MEMBER_ID = '00000000-0000-4000-c000-000000000002' as TeamMember.TeamMemberId;
const PLAYER_USER_ID = '00000000-0000-4000-a000-000000000002' as User.UserId;

const STAR_MEMBER_ID = '00000000-0000-4000-c000-000000000003' as TeamMember.TeamMemberId;
const STAR_USER_ID = '00000000-0000-4000-a000-000000000003' as User.UserId;

const now = Date.now();

// ---------------------------------------------------------------------------
// Fixture rows — three team members, one row each (all answered nothing
// recently except the "star" member, who has one fresh correct scenario).
// ---------------------------------------------------------------------------

const rows: ReadonlyArray<RulesLeaderboardRow> = [
  {
    team_member_id: MANAGER_MEMBER_ID,
    user_id: MANAGER_USER_ID,
    username: 'manager',
    name: Option.none(),
    avatar: Option.none(),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    scenario_id: Option.none(),
    last_correct_at: Option.none(),
  },
  {
    team_member_id: PLAYER_MEMBER_ID,
    user_id: PLAYER_USER_ID,
    username: 'player',
    name: Option.none(),
    avatar: Option.none(),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    scenario_id: Option.none(),
    last_correct_at: Option.none(),
  },
  {
    team_member_id: STAR_MEMBER_ID,
    user_id: STAR_USER_ID,
    username: 'star',
    name: Option.none(),
    avatar: Option.none(),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    scenario_id: Option.some(REAL_SCENARIO_ID),
    last_correct_at: Option.some(DateTime.makeUnsafe(now)),
  },
];

const managerCurrentUser = {
  id: MANAGER_USER_ID,
  discordId: '1',
  username: 'manager',
  avatar: Option.none(),
  isProfileComplete: true,
  name: Option.none(),
  birthDate: Option.none(),
  gender: Option.none(),
  locale: 'en',
  isGlobalAdmin: false,
  displayName: 'manager',
} as unknown as Auth.CurrentUser;

const playerCurrentUser = {
  ...managerCurrentUser,
  id: PLAYER_USER_ID,
  username: 'player',
  displayName: 'player',
} as unknown as Auth.CurrentUser;

const globalAdminCurrentUser = {
  ...playerCurrentUser,
  isGlobalAdmin: true,
} as unknown as Auth.CurrentUser;

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];
const MANAGER_PERMISSIONS: readonly Role.Permission[] = [
  'roster:view',
  'member:view',
  'member:edit',
];

const managerMembership = new MembershipWithRole({
  id: MANAGER_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: MANAGER_USER_ID,
  active: true,
  role_names: ['Captain'],
  permissions: MANAGER_PERMISSIONS,
});

const playerMembership = new MembershipWithRole({
  id: PLAYER_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: PLAYER_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: PLAYER_PERMISSIONS,
});

describe('buildRulesLeaderboardResponse — visibility rule', () => {
  it('a member:edit caller sees every entry, scope "team"', () => {
    const response = buildRulesLeaderboardResponse(rows, managerCurrentUser, managerMembership);

    expect(response.scope).toBe('team');
    expect(response.entries).toHaveLength(3);
    // Ranked by strength desc — the star member (fresh correct answer) is rank 1.
    expect(response.entries[0]?.teamMemberId).toBe(STAR_MEMBER_ID);
    expect(response.entries[0]?.rank).toBe(1);
  });

  it('a global admin (not necessarily member:edit) also sees every entry, scope "team"', () => {
    const response = buildRulesLeaderboardResponse(rows, globalAdminCurrentUser, playerMembership);

    expect(response.scope).toBe('team');
    expect(response.entries).toHaveLength(3);
  });

  it('a plain member sees exactly one entry — their own — scope "self"', () => {
    const response = buildRulesLeaderboardResponse(rows, playerCurrentUser, playerMembership);

    expect(response.scope).toBe('self');
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0]?.teamMemberId).toBe(PLAYER_MEMBER_ID);
  });

  it("a plain member's single visible entry carries their TRUE team rank, not 1", () => {
    const response = buildRulesLeaderboardResponse(rows, playerCurrentUser, playerMembership);

    // Two members (manager, player) tie at strength 0 — player and manager
    // both never answered anything. The star member outranks both. Ties
    // break by teamMemberId ascending (see RulesLeaderboard.rankRulesLeaderboard).
    const expectedRank = MANAGER_MEMBER_ID < PLAYER_MEMBER_ID ? 3 : 2;
    expect(response.entries[0]?.rank).toBe(expectedRank);
    expect(response.entries[0]?.rank).not.toBe(1);
  });

  it('ranking happens over the WHOLE team before filtering — a plain member never reads as rank 1 while a stronger member exists', () => {
    const managerResponse = buildRulesLeaderboardResponse(
      rows,
      managerCurrentUser,
      managerMembership,
    );
    const playerResponse = buildRulesLeaderboardResponse(rows, playerCurrentUser, playerMembership);

    const playerEntryFromFullBoard = managerResponse.entries.find(
      (e) => e.teamMemberId === PLAYER_MEMBER_ID,
    );
    expect(playerEntryFromFullBoard).toBeDefined();
    expect(playerResponse.entries[0]?.rank).toBe(playerEntryFromFullBoard?.rank);
  });
});
