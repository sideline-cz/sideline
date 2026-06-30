// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require:
//   - Migration 1790100002: CREATE TABLE personal_event_channels
//   - A new PersonalEventChannelsRepository service with methods:
//       reservePersonalChannel(teamId, teamMemberId) → INSERT ON CONFLICT DO NOTHING
//       savePersonalChannelId(teamId, teamMemberId, discordChannelId) → UPDATE
//       getMembersNeedingPersonalChannel(teamId, limit) → rows with discord_channel_id IS NULL
//       getPersonalChannel(teamId, teamMemberId) → Option<{id, discord_channel_id}>
//       deletePersonalChannel(teamId, teamMemberId) → Option<Snowflake> (returns channel id)
// These tests WILL FAIL until the developer implements the repository and migration.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
// TDD: implement PersonalEventChannelsRepository
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  // TDD: implement PersonalEventChannelsRepository.Default
  PersonalEventChannelsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  GroupsRepository.Default,
  TeamSettingsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

const createGroup = (
  teamId: Team.TeamId,
  name: string,
  parentId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, parentId, Option.none(), Option.none()),
    ),
  );

const addGroupMember = (groupId: GroupModel.GroupId, teamMemberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.addMemberById(groupId, teamMemberId)),
  );

const seedTeamWithMember = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, member })),
  );

// ---------------------------------------------------------------------------
// Tests: reserve-first idempotency (INSERT ON CONFLICT DO NOTHING)
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — reservePersonalChannel idempotency', () => {
  it.effect(
    'reserve twice for same (team_id, team_member_id) does NOT error and does NOT duplicate',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '400000000000000001',
            'reserve-user-1',
            '401010101010101010' as Discord.Snowflake,
          ),
        ),
        // First reserve
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              // TDD: implement reservePersonalChannel
              repo.reservePersonalChannel(seed.team.id, seed.member.id),
            ),
          ),
        ),
        // Second reserve — must not error (ON CONFLICT DO NOTHING)
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        // Verify only one row exists
        Effect.bind('count', ({ seed }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe<{ count: string }>(`
              SELECT COUNT(*)::text AS count FROM personal_event_channels
              WHERE team_id = '${seed.team.id}' AND team_member_id = '${seed.member.id}'
            `),
            ),
            Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
          ),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('two different members of the same team each get their own reserve row', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('402000000000000001', 'two-members-u1')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('402020202020202020' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('userId2', () => createUser('402000000000000002', 'two-members-u2')),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.tap(({ team, member1, member2 }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            Effect.all([
              repo.reservePersonalChannel(team.id, member1.id),
              repo.reservePersonalChannel(team.id, member2.id),
            ]),
          ),
        ),
      ),
      Effect.bind('count', ({ team }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe<{ count: string }>(`
              SELECT COUNT(*)::text AS count FROM personal_event_channels
              WHERE team_id = '${team.id}'
            `),
          ),
          Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
        ),
      ),
      Effect.tap(({ count }) =>
        Effect.sync(() => {
          expect(count).toBe(2);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: GetMembersNeedingPersonalChannel
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — getMembersNeedingPersonalChannel', () => {
  it.effect('INCLUDES rows with discord_channel_id IS NULL (reserved but not yet created)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '403000000000000001',
          'needs-channel-1',
          '403030303030303030' as Discord.Snowflake,
        ),
      ),
      // Reserve without saving a channel id (discord_channel_id stays NULL)
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
        ),
      ),
      Effect.bind('results', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // TDD: implement getMembersNeedingPersonalChannel(teamId, limit)
            repo.getMembersNeedingPersonalChannel(seed.team.id, Option.none(), 100),
          ),
        ),
      ),
      Effect.tap(({ results, seed }) =>
        Effect.sync(() => {
          const memberIds = results.map((r: any) => r.team_member_id);
          expect(memberIds).toContain(seed.member.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'EXCLUDES rows where discord_channel_id IS NOT NULL (channel already provisioned)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '404000000000000001',
            'has-channel-1',
            '404040404040404040' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.all([
                repo.reservePersonalChannel(seed.team.id, seed.member.id),
                // TDD: implement savePersonalChannelId(teamId, memberId, channelId)
                repo.savePersonalChannelId(
                  seed.team.id,
                  seed.member.id,
                  '404111111111111111' as Discord.Snowflake,
                  'events-{discord_id}',
                ),
              ]),
            ),
          ),
        ),
        Effect.bind('results', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.getMembersNeedingPersonalChannel(seed.team.id, Option.none(), 100),
            ),
          ),
        ),
        Effect.tap(({ results, seed }) =>
          Effect.sync(() => {
            const memberIds = results.map((r: any) => r.team_member_id);
            // Member who already has a channel should NOT appear
            expect(memberIds).not.toContain(seed.member.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('INCLUDES members with no reserve row at all (LEFT JOIN pattern)', () =>
    // The query should also detect team_members who have NO personal_event_channels row
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '405000000000000001',
          'no-row-at-all',
          '405050505050505050' as Discord.Snowflake,
        ),
      ),
      // Do NOT call reservePersonalChannel — member has no row
      Effect.bind('results', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.getMembersNeedingPersonalChannel(seed.team.id, Option.none(), 100),
          ),
        ),
      ),
      Effect.tap(({ results, seed }) =>
        Effect.sync(() => {
          const memberIds = results.map((r: any) => r.team_member_id);
          // Member with no reserve row should be returned (LEFT JOIN + WHERE IS NULL)
          expect(memberIds).toContain(seed.member.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: savePersonalChannelId then getPersonalChannel
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — savePersonalChannelId / getPersonalChannel', () => {
  it.effect('save then get returns Some with correct discord_channel_id', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '406000000000000001',
          'save-get-1',
          '406060606060606060' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            Effect.all([
              repo.reservePersonalChannel(seed.team.id, seed.member.id),
              repo.savePersonalChannelId(
                seed.team.id,
                seed.member.id,
                '406111111111111111' as Discord.Snowflake,
                'events-{discord_id}',
              ),
            ]),
          ),
        ),
      ),
      Effect.bind('channel', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // TDD: implement getPersonalChannel(teamId, memberId) → Option<row>
            repo.getPersonalChannel(seed.team.id, seed.member.id),
          ),
        ),
      ),
      Effect.tap(({ channel }) =>
        Effect.sync(() => {
          expect(Option.isSome(channel)).toBe(true);
          const row = Option.getOrThrow(channel);
          expect(Option.isSome(row.discord_channel_id)).toBe(true);
          expect(Option.getOrNull(row.discord_channel_id)).toBe('406111111111111111');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: UNIQUE constraint on discord_channel_id
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — UNIQUE on discord_channel_id', () => {
  it.effect(
    'assigning the same discord_channel_id to two different members throws a unique violation',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId1', () => createUser('407000000000000001', 'unique-ch-u1')),
        Effect.bind('team', ({ userId1 }) =>
          createTeam('407070707070707070' as Discord.Snowflake, userId1),
        ),
        Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('userId2', () => createUser('407000000000000002', 'unique-ch-u2')),
        Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.tap(({ team, member1, member2 }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.all([
                repo.reservePersonalChannel(team.id, member1.id),
                repo.reservePersonalChannel(team.id, member2.id),
                repo.savePersonalChannelId(
                  team.id,
                  member1.id,
                  '407111111111111111' as Discord.Snowflake,
                  'events-{discord_id}',
                ),
              ]),
            ),
          ),
        ),
        // Assigning same channel id to member2 should fail with unique constraint
        Effect.bind('result', ({ team, member2 }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .savePersonalChannelId(
                  team.id,
                  member2.id,
                  '407111111111111111' as Discord.Snowflake,
                  'events-{discord_id}',
                )
                .pipe(Effect.exit),
            ),
          ),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            // Must be a failure (error) due to unique constraint violation
            expect(Exit.isFailure(result)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Tests: DeletePersonalChannel
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — deletePersonalChannel', () => {
  it.effect('deletePersonalChannel returns Some(channelId) and removes the row', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '408000000000000001',
          'delete-ch-1',
          '408080808080808080' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            Effect.all([
              repo.reservePersonalChannel(seed.team.id, seed.member.id),
              repo.savePersonalChannelId(
                seed.team.id,
                seed.member.id,
                '408111111111111111' as Discord.Snowflake,
                'events-{discord_id}',
              ),
            ]),
          ),
        ),
      ),
      Effect.bind('deleted', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // TDD: implement deletePersonalChannel(teamId, memberId) → Option<Snowflake>
            repo.deletePersonalChannel(seed.team.id, seed.member.id),
          ),
        ),
      ),
      Effect.tap(({ deleted }) =>
        Effect.sync(() => {
          expect(Option.isSome(deleted)).toBe(true);
          expect(Option.getOrNull(deleted)).toBe('408111111111111111');
        }),
      ),
      // Verify the row is gone
      Effect.bind('count', ({ seed }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe<{ count: string }>(`
            SELECT COUNT(*)::text AS count FROM personal_event_channels
            WHERE team_id = '${seed.team.id}' AND team_member_id = '${seed.member.id}'
          `),
          ),
          Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
        ),
      ),
      Effect.tap(({ count }) =>
        Effect.sync(() => {
          expect(count).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('deletePersonalChannel for member with no channel returns Option.none()', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '409000000000000001',
          'delete-no-ch-1',
          '409090909090909090' as Discord.Snowflake,
        ),
      ),
      // Reserve but don't save channel id
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
        ),
      ),
      Effect.bind('deleted', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.deletePersonalChannel(seed.team.id, seed.member.id)),
        ),
      ),
      Effect.tap(({ deleted }) =>
        Effect.sync(() => {
          // No channel id was assigned, so returns None
          expect(Option.isNone(deleted)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: group-restricted provisioning + de-provisioning
// ---------------------------------------------------------------------------

// Seeds a team with two members; member1 joins `Group A`, member2 stays ungrouped.
const seedTeamWithGroup = (guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId1', () => createUser(`${guildId}1`, `grp-u1-${guildId}`)),
    Effect.bind('team', ({ userId1 }) => createTeam(guildId, userId1)),
    Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
    Effect.bind('userId2', () => createUser(`${guildId}2`, `grp-u2-${guildId}`)),
    Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
    Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
    Effect.tap(({ groupA, member1 }) => addGroupMember(groupA.id, member1.id)),
  );

describe('PersonalEventChannelsRepository — group-restricted provisioning', () => {
  it.effect('only returns members of the configured group (and excludes others)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithGroup('411000000000000000' as Discord.Snowflake)),
      Effect.bind('results', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.getMembersNeedingPersonalChannel(seed.team.id, Option.some(seed.groupA.id), 100),
          ),
        ),
      ),
      Effect.tap(({ results, seed }) =>
        Effect.sync(() => {
          const memberIds = results.map((r) => r.team_member_id);
          expect(memberIds).toContain(seed.member1.id);
          expect(memberIds).not.toContain(seed.member2.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('includes members of a descendant group', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithGroup('412000000000000000' as Discord.Snowflake)),
      // Put member2 into a CHILD of Group A.
      Effect.bind('childGroup', ({ seed }) =>
        createGroup(seed.team.id, 'Group A Child', Option.some(seed.groupA.id)),
      ),
      Effect.tap(({ childGroup, seed }) => addGroupMember(childGroup.id, seed.member2.id)),
      Effect.bind('results', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.getMembersNeedingPersonalChannel(seed.team.id, Option.some(seed.groupA.id), 100),
          ),
        ),
      ),
      Effect.tap(({ results, seed }) =>
        Effect.sync(() => {
          const memberIds = results.map((r) => r.team_member_id);
          expect(memberIds).toContain(seed.member1.id);
          expect(memberIds).toContain(seed.member2.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('populates a non-empty name for the channel format', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithGroup('413000000000000000' as Discord.Snowflake)),
      Effect.bind('results', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.getMembersNeedingPersonalChannel(seed.team.id, Option.none(), 100),
          ),
        ),
      ),
      Effect.tap(({ results }) =>
        Effect.sync(() => {
          expect(results.length).toBeGreaterThan(0);
          for (const r of results) {
            expect(typeof r.name).toBe('string');
            expect(r.name.length).toBeGreaterThan(0);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('getMembersToDeprovision returns channelled members outside the group', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithGroup('414000000000000000' as Discord.Snowflake)),
      // Both members have a provisioned channel.
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            Effect.all([
              repo
                .reservePersonalChannel(seed.team.id, seed.member1.id)
                .pipe(
                  Effect.andThen(
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member1.id,
                      '414111111111111111' as Discord.Snowflake,
                      'events-{discord_id}',
                    ),
                  ),
                ),
              repo
                .reservePersonalChannel(seed.team.id, seed.member2.id)
                .pipe(
                  Effect.andThen(
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member2.id,
                      '414222222222222222' as Discord.Snowflake,
                      'events-{discord_id}',
                    ),
                  ),
                ),
            ]),
          ),
        ),
      ),
      Effect.bind('results', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getMembersToDeprovision(seed.team.id, seed.groupA.id, 100)),
        ),
      ),
      Effect.tap(({ results, seed }) =>
        Effect.sync(() => {
          const memberIds = results.map((r) => r.team_member_id);
          // member2 is outside Group A → must be de-provisioned; member1 is inside → kept.
          expect(memberIds).toContain(seed.member2.id);
          expect(memberIds).not.toContain(seed.member1.id);
          const member2Row = results.find((r) => r.team_member_id === seed.member2.id);
          expect(member2Row?.discord_channel_id).toBe('414222222222222222');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: rename-on-format-change drift detection (getChannelsToRename)
// ---------------------------------------------------------------------------

const setTeamChannelFormat = (teamId: Team.TeamId, format: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 0,
        discordPersonalEventsChannelFormat: format,
      }),
    ),
  );

describe('PersonalEventChannelsRepository — getChannelsToRename', () => {
  it.effect('returns channels whose applied format differs from the current team format', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '415000000000000001',
          'rename-me-1',
          '415050505050505050' as Discord.Snowflake,
        ),
      ),
      // Provision a channel with the original format.
      Effect.tap(({ seed }) => setTeamChannelFormat(seed.team.id, 'events-{discord_id}')),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .reservePersonalChannel(seed.team.id, seed.member.id)
              .pipe(
                Effect.andThen(
                  repo.savePersonalChannelId(
                    seed.team.id,
                    seed.member.id,
                    '415111111111111111' as Discord.Snowflake,
                    'events-{discord_id}',
                  ),
                ),
              ),
          ),
        ),
      ),
      // No drift yet → nothing to rename.
      Effect.bind('before', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getChannelsToRename(seed.team.id, 100)),
        ),
      ),
      // Change the team format → the channel is now drifted.
      Effect.tap(({ seed }) => setTeamChannelFormat(seed.team.id, 'attendance-{name}')),
      Effect.bind('after', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getChannelsToRename(seed.team.id, 100)),
        ),
      ),
      Effect.tap(({ before, after, seed }) =>
        Effect.sync(() => {
          expect(before).toHaveLength(0);
          expect(after).toHaveLength(1);
          expect(after[0]?.team_member_id).toBe(seed.member.id);
          expect(after[0]?.channel_format).toBe('attendance-{name}');
          expect(after[0]?.discord_channel_id).toBe('415111111111111111');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('savePersonalChannelFormat clears the drift', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '416000000000000001',
          'rename-me-2',
          '416060606060606060' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => setTeamChannelFormat(seed.team.id, 'attendance-{name}')),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .reservePersonalChannel(seed.team.id, seed.member.id)
              .pipe(
                Effect.andThen(
                  repo.savePersonalChannelId(
                    seed.team.id,
                    seed.member.id,
                    '416111111111111111' as Discord.Snowflake,
                    'events-{discord_id}',
                  ),
                ),
              ),
          ),
        ),
      ),
      // Drifted (applied 'events-{discord_id}' vs current 'attendance-{name}').
      Effect.bind('drifted', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getChannelsToRename(seed.team.id, 100)),
        ),
      ),
      // Record the new applied format → drift cleared.
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.savePersonalChannelFormat(seed.team.id, seed.member.id, 'attendance-{name}'),
          ),
        ),
      ),
      Effect.bind('cleared', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getChannelsToRename(seed.team.id, 100)),
        ),
      ),
      Effect.tap(({ drifted, cleared }) =>
        Effect.sync(() => {
          expect(drifted).toHaveLength(1);
          expect(cleared).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: findOwnedPersonalChannel (backs /refresh-events channel detection)
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — findOwnedPersonalChannel', () => {
  it.effect('returns the member when the channel is theirs, None for others/unknown channel', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '417000000000000001',
          'owns-channel-1',
          '417070707070707070' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .reservePersonalChannel(seed.team.id, seed.member.id)
              .pipe(
                Effect.andThen(
                  repo.savePersonalChannelId(
                    seed.team.id,
                    seed.member.id,
                    '417111111111111111' as Discord.Snowflake,
                    'events-{discord_id}',
                  ),
                ),
              ),
          ),
        ),
      ),
      Effect.bind('owner', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findOwnedPersonalChannel(
              seed.team.id,
              '417111111111111111' as Discord.Snowflake,
              '417000000000000001' as Discord.Snowflake,
            ),
          ),
        ),
      ),
      Effect.bind('wrongUser', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findOwnedPersonalChannel(
              seed.team.id,
              '417111111111111111' as Discord.Snowflake,
              '999999999999999999' as Discord.Snowflake,
            ),
          ),
        ),
      ),
      Effect.bind('wrongChannel', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findOwnedPersonalChannel(
              seed.team.id,
              '417999999999999999' as Discord.Snowflake,
              '417000000000000001' as Discord.Snowflake,
            ),
          ),
        ),
      ),
      Effect.tap(({ owner, wrongUser, wrongChannel, seed }) =>
        Effect.sync(() => {
          expect(Option.getOrNull(owner)).toBe(seed.member.id);
          expect(Option.isNone(wrongUser)).toBe(true);
          expect(Option.isNone(wrongChannel)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
