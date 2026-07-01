/**
 * Tests for the Guild/CheckTeamAdmin RPC handler logic.
 *
 * Mirrors GetUpcomingEventsForUserRpc.test.ts and EventRpc.test.ts: the handler
 * is a thin composition over TeamsRepository.findByGuildId +
 * TeamMembersRepository.findMembershipByDiscordAndTeam, so we exercise the same
 * data-flow decisions the handler makes by driving the repository abstractions
 * directly rather than mocking at the SQL layer.
 *
 * TDD mode — written BEFORE the `Guild/CheckTeamAdmin` handler branch is wired
 * up in `applications/server/src/rpc/guild/index.ts`. These tests exercise the
 * repository contracts the handler depends on and are expected to compile and
 * pass against the repositories today; the handler wiring itself is verified
 * once `Guild/CheckTeamAdmin` is implemented (see GuildRpcGroup.ts — the RPC
 * shape already exists in @sideline/domain).
 */
import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

// --- Test IDs ---
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_GUILD_ID = '999999999999999999' as Discord.Snowflake;
const ADMIN_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const NON_ADMIN_DISCORD_ID = '222222222222222222' as Discord.Snowflake;
const UNKNOWN_DISCORD_ID = '333333333333333333' as Discord.Snowflake;
const UNKNOWN_GUILD_ID = '000000000000000001' as Discord.Snowflake;

// --- Minimal team record helper ---
const makeTeam = () => ({
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: TEST_GUILD_ID,
  created_by: 'user-1',
  created_at: new Date(),
  updated_at: new Date(),
});

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findById: (id: Team.TeamId) =>
    id === TEST_TEAM_ID ? Effect.succeed(Option.some(makeTeam())) : Effect.succeed(Option.none()),
  findByGuildId: (guildId: string) =>
    guildId === TEST_GUILD_ID
      ? Effect.succeed(Option.some(makeTeam()))
      : Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

/**
 * The handler's admin gate mirrors `Guild/IdentifyEventsChannel`:
 *   membership.permissions.includes('team:manage')
 */
const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByDiscordAndTeam: (discordId: Discord.Snowflake, _teamId: Team.TeamId) => {
    if (discordId === ADMIN_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: TEST_MEMBER_ID,
          team_id: TEST_TEAM_ID,
          user_id: 'user-1',
          active: true,
          role_names: ['Captain'],
          permissions: ['team:manage'],
        }),
      );
    }
    if (discordId === NON_ADMIN_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: TEST_MEMBER_ID,
          team_id: TEST_TEAM_ID,
          user_id: 'user-2',
          active: true,
          role_names: ['Player'],
          permissions: [] as string[],
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  addMember: () => Effect.die(new Error('Not implemented')),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockProvideLayer = Layer.mergeAll(MockTeamsRepositoryLayer, MockTeamMembersRepositoryLayer);

/**
 * Reproduces the `Guild/CheckTeamAdmin` handler's decision logic (mirrors the
 * admin-gate branch already implemented for `Guild/IdentifyEventsChannel` in
 * `applications/server/src/rpc/guild/index.ts`), so the test exercises the
 * exact same repository contract the handler is expected to compose.
 */
const checkTeamAdmin = (guildId: Discord.Snowflake, discordUserId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.flatMap(({ teams, members }) =>
      teams.findByGuildId(guildId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed({ team_id: Option.none<Team.TeamId>(), is_admin: false }),
            onSome: (team) =>
              members.findMembershipByDiscordAndTeam(discordUserId, team.id).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => ({ team_id: Option.some(team.id), is_admin: false }),
                    onSome: (membership) => ({
                      team_id: Option.some(team.id),
                      is_admin: (membership.permissions as ReadonlyArray<string>).includes(
                        'team:manage',
                      ),
                    }),
                  }),
                ),
              ),
          }),
        ),
      ),
    ),
  );

describe('Guild/CheckTeamAdmin handler logic', () => {
  it.effect('member with team:manage → is_admin true, team_id Some', () =>
    checkTeamAdmin(TEST_GUILD_ID, ADMIN_DISCORD_ID).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.is_admin).toBe(true);
          expect(Option.isSome(result.team_id)).toBe(true);
          expect(Option.isSome(result.team_id) && result.team_id.value).toBe(TEST_TEAM_ID);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('member without team:manage → is_admin false', () =>
    checkTeamAdmin(TEST_GUILD_ID, NON_ADMIN_DISCORD_ID).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.is_admin).toBe(false);
          expect(Option.isSome(result.team_id)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('no membership for the discord user → is_admin false', () =>
    checkTeamAdmin(TEST_GUILD_ID, UNKNOWN_DISCORD_ID).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.is_admin).toBe(false);
          // The guild resolves to a known team even though the caller has no membership.
          expect(Option.isSome(result.team_id)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('unknown guild (no team) → { team_id: None, is_admin: false }', () =>
    checkTeamAdmin(UNKNOWN_GUILD_ID, ADMIN_DISCORD_ID).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.is_admin).toBe(false);
          expect(Option.isNone(result.team_id)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );
});
