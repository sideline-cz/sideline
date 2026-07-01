import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  RostersRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        // Both null — this is the shape that previously broke findMemberEntries.
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const createRoster = (teamId: Team.TeamId) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: 'Squad',
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Regression: findMemberEntries must SELECT discord_nickname / discord_display_name
//
// The shared RosterEntry result schema (TeamMembersRepository) requires
// `discord_nickname` and `discord_display_name` (added with the shared
// display-name change). findMemberEntries previously omitted them from its
// SELECT, so decoding the result row failed with
//   "SQL result parsing failed: Missing key at [0].discord_nickname"
// for ANY roster with at least one member — surfacing as a 500 on getRoster
// and a 404 on the web roster detail page. This test loads a roster with a
// member whose nickname/display-name are NULL and asserts it decodes.
// ---------------------------------------------------------------------------

describe('RostersRepository.findMemberEntriesById', () => {
  it.effect('decodes a member whose discord_nickname/display_name are null', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000001', 'nicknameless')),
      Effect.bind('team', ({ userId }) =>
        createTeam('500606060606060601' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ roster, member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.addMemberById(roster.id, member.id)),
        ),
      ),
      Effect.bind('entries', ({ roster }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findMemberEntriesById(roster.id)),
        ),
      ),
      Effect.tap(({ entries, member }) =>
        Effect.sync(() => {
          // Before the fix this Effect failed during result decode and never
          // reached here. Now it resolves with a properly-decoded entry.
          expect(entries).toHaveLength(1);
          expect(entries[0]?.member_id).toBe(member.id);
          expect(entries[0]?.username).toBe('nicknameless');
          expect(Option.isNone(entries[0]?.discord_nickname)).toBe(true);
          expect(Option.isNone(entries[0]?.discord_display_name)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // ---------------------------------------------------------------------------
  // Channel/GetRosterMembers coverage: findMemberEntriesById returns all roster
  // members including those without a linked Discord account.
  // The RPC handler (Channel/GetRosterMembers) is responsible for filtering out
  // members whose discord_id is null before returning RosterMemberDiscord objects.
  // These tests verify the raw repository output that the RPC handler consumes.
  // ---------------------------------------------------------------------------

  it.effect('returns all members for a roster regardless of discord_id presence', () =>
    Effect.Do.pipe(
      // User A — has a discord account (discord_id is always set from upsertFromDiscord)
      Effect.bind('userAId', () => createUser('600000000000000001', 'player-with-discord')),
      // User B — second member, also has discord (all users have discord_id via upsertFromDiscord)
      Effect.bind('userBId', () => createUser('600000000000000002', 'player-also-discord')),
      Effect.bind('team', ({ userAId }) =>
        createTeam('600606060606060601' as Discord.Snowflake, userAId),
      ),
      Effect.bind('memberA', ({ team, userAId }) => addTeamMember(team.id, userAId)),
      Effect.bind('memberB', ({ team, userBId }) => addTeamMember(team.id, userBId)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      // Add both members to the roster
      Effect.tap(({ roster, memberA }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.addMemberById(roster.id, memberA.id)),
        ),
      ),
      Effect.tap(({ roster, memberB }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.addMemberById(roster.id, memberB.id)),
        ),
      ),
      Effect.bind('entries', ({ roster }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findMemberEntriesById(roster.id)),
        ),
      ),
      Effect.tap(({ entries }) =>
        Effect.sync(() => {
          // Both members returned — the RPC handler filters by non-null discord_id
          expect(entries).toHaveLength(2);
          const usernames = entries.map((e) => e.username).sort();
          expect(usernames).toEqual(['player-also-discord', 'player-with-discord']);
          // All entries have non-null discord_id (set via upsertFromDiscord)
          for (const entry of entries) {
            expect(entry.discord_id).toBeDefined();
            expect(entry.discord_id).not.toBeNull();
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns empty array for unknown roster id', () =>
    Effect.Do.pipe(
      Effect.bind('entries', () =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // Use a well-formed but non-existent UUID
            repo.findMemberEntriesById('00000000-0000-0000-0000-999999999999' as never),
          ),
        ),
      ),
      Effect.tap(({ entries }) =>
        Effect.sync(() => {
          expect(entries).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns empty array when roster exists but has no members', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('700000000000000001', 'team-owner')),
      Effect.bind('team', ({ userId }) =>
        createTeam('700606060606060601' as Discord.Snowflake, userId),
      ),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      // Don't add any members to the roster
      Effect.bind('entries', ({ roster }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findMemberEntriesById(roster.id)),
        ),
      ),
      Effect.tap(({ entries }) =>
        Effect.sync(() => {
          expect(entries).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// findRosterIdsByMember — used by reactivateMember/deactivateMember Discord
// cleanup and by listMemberRosters to scope the roster list to a single member.
// ---------------------------------------------------------------------------

describe('RostersRepository.findRosterIdsByMember', () => {
  it.effect('returns only the roster ids the member belongs to', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000001', 'multi-roster-member')),
      Effect.bind('team', ({ userId }) =>
        createTeam('900606060606060601' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('rosterA', ({ team }) => createRoster(team.id)),
      Effect.bind('rosterB', ({ team }) => createRoster(team.id)),
      // Member is only added to rosterA.
      Effect.tap(({ rosterA, member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.addMemberById(rosterA.id, member.id)),
        ),
      ),
      Effect.bind('rosterIds', ({ member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterIdsByMember(member.id)),
        ),
      ),
      Effect.tap(({ rosterIds, rosterA, rosterB }) =>
        Effect.sync(() => {
          expect(rosterIds).toHaveLength(1);
          expect(rosterIds).toContain(rosterA.id);
          expect(rosterIds).not.toContain(rosterB.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns an empty array for a member on no rosters', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000002', 'rosterless-member')),
      Effect.bind('team', ({ userId }) =>
        createTeam('900606060606060602' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('rosterIds', ({ member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterIdsByMember(member.id)),
        ),
      ),
      Effect.tap(({ rosterIds }) =>
        Effect.sync(() => {
          expect(rosterIds).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('reflects removal — roster id disappears after removeMemberById', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('900000000000000003', 'removed-roster-member')),
      Effect.bind('team', ({ userId }) =>
        createTeam('900606060606060603' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ roster, member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.addMemberById(roster.id, member.id)),
        ),
      ),
      Effect.tap(({ roster, member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.removeMemberById(roster.id, member.id)),
        ),
      ),
      Effect.bind('rosterIds', ({ member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterIdsByMember(member.id)),
        ),
      ),
      Effect.tap(({ rosterIds }) =>
        Effect.sync(() => {
          expect(rosterIds).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
