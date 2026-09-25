// Integration tests for PersonalEventChannelsRepository (real Postgres).
// Key methods under test:
//   reservePersonalChannel(teamId, teamMemberId, bucket) → lease-based INSERT ON CONFLICT
//     DO UPDATE: re-claims a NULL reservation only once its updated_at lease expires
//   savePersonalChannelId(teamId, teamMemberId, discordChannelId, format, bucket) → UPDATE
//   getMembersNeedingPersonalChannel(teamId, limit) → one row per unprovisioned desired bucket
//   deletePersonalChannel(teamId, teamMemberId, bucket) → Option<Snowflake> (returns channel id)

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
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
  EventsRepository.Default,
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
// Tests: reserve-first idempotency (lease-based INSERT ON CONFLICT DO UPDATE)
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
// Tests: stale reservation re-claim (lease-based conditional re-claim)
// ---------------------------------------------------------------------------
//
// Bug: a NULL discord_channel_id row (reserved but the channel was never
// actually created, e.g. the process crashed mid-provisioning) permanently
// blocks that member from ever being re-provisioned because the old
// `ON CONFLICT DO NOTHING` reserve always reports "not reserved" for an
// existing row. The fix re-claims a NULL row once its `updated_at` lease is
// older than 15 minutes.

const backdateReservation = (
  teamId: Team.TeamId,
  teamMemberId: TeamMember.TeamMemberId,
  interval: string,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`
        UPDATE personal_event_channels
        SET updated_at = now() - interval '${interval}'
        WHERE team_id = '${teamId}' AND team_member_id = '${teamMemberId}'
      `),
    ),
  );

const countReservations = (teamId: Team.TeamId, teamMemberId: TeamMember.TeamMemberId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM personal_event_channels
        WHERE team_id = '${teamId}' AND team_member_id = '${teamMemberId}'
      `),
    ),
    Effect.map((rows) => parseInt(rows[0]?.count ?? '0', 10)),
  );

describe('PersonalEventChannelsRepository — stale reservation re-claim', () => {
  it.effect(
    'regression: a stale NULL reservation (older than the lease) is re-claimed, unblocking provisioning',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '420000000000000001',
            'stale-reclaim-1',
            '420020202020202020' as Discord.Snowflake,
          ),
        ),
        // First reserve attempt succeeds but the channel is never created
        // (discord_channel_id stays NULL) — simulating a crashed/failed attempt.
        Effect.bind('firstReserve', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        Effect.tap(({ firstReserve }) =>
          Effect.sync(() => {
            expect(firstReserve).toBe(true);
          }),
        ),
        // Simulate the lease going stale (older than 15 minutes).
        Effect.tap(({ seed }) => backdateReservation(seed.team.id, seed.member.id, '1 hour')),
        // A later provisioning pass should be able to re-claim the stale row.
        Effect.bind('secondReserve', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        Effect.tap(({ secondReserve }) =>
          Effect.sync(() => {
            expect(secondReserve).toBe(true);
          }),
        ),
        // No duplicate row was created — the same row was updated in place.
        Effect.bind('count', ({ seed }) => countReservations(seed.team.id, seed.member.id)),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(1);
          }),
        ),
        // End-to-end recovery: provisioning the channel now removes the member
        // from the "needs a channel" queue.
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.savePersonalChannelId(
                seed.team.id,
                seed.member.id,
                '420111111111111111' as Discord.Snowflake,
                'events-{discord_id}',
              ),
            ),
          ),
        ),
        Effect.bind('needing', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.getMembersNeedingPersonalChannel(seed.team.id, Option.none(), 100),
            ),
          ),
        ),
        Effect.tap(({ needing, seed }) =>
          Effect.sync(() => {
            const memberIds = needing.map((r) => r.team_member_id);
            expect(memberIds).not.toContain(seed.member.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'mutual exclusion: a recent NULL reservation (within the lease) is NOT re-claimed',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '421000000000000001',
            'mutual-exclusion-1',
            '421020202020202020' as Discord.Snowflake,
          ),
        ),
        Effect.bind('firstReserve', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        Effect.tap(({ firstReserve }) =>
          Effect.sync(() => {
            expect(firstReserve).toBe(true);
          }),
        ),
        // No backdating — the row's lease is still fresh.
        Effect.bind('secondReserve', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        Effect.tap(({ secondReserve }) =>
          Effect.sync(() => {
            expect(secondReserve).toBe(false);
          }),
        ),
        Effect.bind('count', ({ seed }) => countReservations(seed.team.id, seed.member.id)),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'already-provisioned: a row with a non-NULL discord_channel_id is never re-claimed, even if stale',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '422000000000000001',
            'already-provisioned-1',
            '422020202020202020' as Discord.Snowflake,
          ),
        ),
        Effect.bind('firstReserve', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        Effect.tap(({ firstReserve }) =>
          Effect.sync(() => {
            expect(firstReserve).toBe(true);
          }),
        ),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.savePersonalChannelId(
                seed.team.id,
                seed.member.id,
                '422111111111111111' as Discord.Snowflake,
                'events-{discord_id}',
              ),
            ),
          ),
        ),
        // Backdate the lease to prove the guard against re-claiming is the
        // non-NULL discord_channel_id, not the 15-minute lease window.
        Effect.tap(({ seed }) => backdateReservation(seed.team.id, seed.member.id, '1 hour')),
        Effect.bind('secondReserve', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        Effect.tap(({ secondReserve }) =>
          Effect.sync(() => {
            expect(secondReserve).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('fresh member: reserving a member with no prior row succeeds', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '423000000000000001',
          'fresh-member-1',
          '423020202020202020' as Discord.Snowflake,
        ),
      ),
      Effect.bind('reserved', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
        ),
      ),
      Effect.tap(({ reserved }) =>
        Effect.sync(() => {
          expect(reserved).toBe(true);
        }),
      ),
      Effect.bind('count', ({ seed }) => countReservations(seed.team.id, seed.member.id)),
      Effect.tap(({ count }) =>
        Effect.sync(() => {
          expect(count).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    // Two reserves against the same stale row yield exactly one winner and no
    // duplicate. Mutual exclusion is guaranteed by the single atomic
    // INSERT ... ON CONFLICT DO UPDATE statement (autocommit per statement), so
    // the outcome is interleaving-independent — this asserts that property holds
    // rather than exercising a genuine cross-transaction race.
    'two reserves against the same stale row yield exactly one winner (no duplicate)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '424000000000000001',
            'concurrent-reclaim-1',
            '424020202020202020' as Discord.Snowflake,
          ),
        ),
        Effect.bind('firstReserve', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.reservePersonalChannel(seed.team.id, seed.member.id)),
          ),
        ),
        Effect.tap(({ firstReserve }) =>
          Effect.sync(() => {
            expect(firstReserve).toBe(true);
          }),
        ),
        Effect.tap(({ seed }) => backdateReservation(seed.team.id, seed.member.id, '1 hour')),
        Effect.bind('results', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.all(
                [
                  repo.reservePersonalChannel(seed.team.id, seed.member.id),
                  repo.reservePersonalChannel(seed.team.id, seed.member.id),
                ],
                { concurrency: 'unbounded' },
              ),
            ),
          ),
        ),
        Effect.tap(({ results }) =>
          Effect.sync(() => {
            const winners = results.filter((r) => r === true);
            const losers = results.filter((r) => r === false);
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
          }),
        ),
        Effect.bind('count', ({ seed }) => countReservations(seed.team.id, seed.member.id)),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(1);
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

// Nastavitelná docházka (plan §6.6, S5): `Guild/GetPersonalChannel` /
// `getPersonalChannel` / `_getChannel` are DELETED. `findOneOption` on
// `(team_id, team_member_id)` returns an arbitrary one of up to three rows in
// split mode — silently wrong — and grep confirms zero consumers. The
// `savePersonalChannelId / getPersonalChannel` describe block that used to
// live here is removed for the same reason; bucket-aware coverage of
// `savePersonalChannelId` lives in the new bucket describe blocks below,
// verified via `getMembersNeedingPersonalChannel` / `listPersonalChannelsForEvent`
// instead of the deleted single-row getter.

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
// Tests: findPersonalChannelOwner (backs /event refresh channel detection)
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — findPersonalChannelOwner', () => {
  it.effect('returns the owner (member + discord id) by channel id, None for unknown channel', () =>
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
            repo.findPersonalChannelOwner(seed.team.id, '417111111111111111' as Discord.Snowflake),
          ),
        ),
      ),
      Effect.bind('wrongChannel', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.findPersonalChannelOwner(seed.team.id, '417999999999999999' as Discord.Snowflake),
          ),
        ),
      ),
      Effect.tap(({ owner, wrongChannel, seed }) =>
        Effect.sync(() => {
          expect(Option.map(owner, (o) => o.team_member_id)).toStrictEqual(
            Option.some(seed.member.id),
          );
          expect(Option.map(owner, (o) => o.discord_id)).toStrictEqual(
            Option.some('417000000000000001'),
          );
          expect(Option.isNone(wrongChannel)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
// ---------------------------------------------------------------------------
// Nastavitelná docházka (plan §3, §6.2, §10.2). Bucket-aware coverage:
// per-bucket reservation, split provisioning, the B3 atomic-switch gate for
// deprovisioning, atomic deletePersonalChannel scoping, bucket on rename rows,
// bucket routing (incl. the transitional one-row invariant), and the guild
// poll waking on a mode flip in either direction.
//
// NOTE ON TYPES: the repository signatures below do not yet accept a `bucket`
// argument (that is the developer's job, plan §6.2). These tests call the
// FUTURE signature and cast to `any` at the call site to avoid a premature
// TypeScript "expected N arguments" error blocking `it.effect` compilation —
// the same convention used in the bot's `formatPersonalChannelName.test.ts`.
// ---------------------------------------------------------------------------

const setTeamPersonalEventsCategory = (teamId: Team.TeamId, categoryId: Discord.Snowflake) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 0,
        discordPersonalEventsCategoryId: Option.some(categoryId),
      }),
    ),
  );

const setPersonalChannelsSplit = (memberId: TeamMember.TeamMemberId, value: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql`UPDATE team_members SET personal_channels_split = ${value} WHERE id = ${memberId}`.pipe(
        Effect.asVoid,
      ),
    ),
  );

describe('PersonalEventChannelsRepository — bucket-aware reservePersonalChannel (plan §3/§6.2)', () => {
  it.effect(
    'reservePersonalChannel(team, member, "training") then "tournament" both succeed; a second "training" reservation fails',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '420000000000000001',
            'bucket-reserve-1',
            '420050505050505050' as Discord.Snowflake,
          ),
        ),
        Effect.bind('training1', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.reservePersonalChannel(seed.team.id, seed.member.id, 'training'),
            ),
          ),
        ),
        Effect.bind('tournament1', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.reservePersonalChannel(seed.team.id, seed.member.id, 'tournament'),
            ),
          ),
        ),
        Effect.bind('training2', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.reservePersonalChannel(seed.team.id, seed.member.id, 'training'),
            ),
          ),
        ),
        Effect.tap(({ training1, tournament1, training2 }) =>
          Effect.sync(() => {
            expect(training1).toBe(true);
            expect(tournament1).toBe(true);
            // Already reserved (fresh, not stale) → the ON CONFLICT DO UPDATE guard
            // does not re-claim it → false.
            expect(training2).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('PersonalEventChannelsRepository — getMembersNeedingPersonalChannel per desired bucket (plan §6.2)', () => {
  it.effect('personal_channels_split = false → exactly one row, bucket "all"', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '421000000000000001',
          'bucket-needed-combined',
          '421050505050505050' as Discord.Snowflake,
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
          const rows = (results as any[]).filter((r) => r.team_member_id === seed.member.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.bucket).toBe('all');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'flipped to personal_channels_split = true → three rows (training/tournament/other), and NO "all" row',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '421000000000000002',
            'bucket-needed-split',
            '421050505050505051' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        Effect.bind('results', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.getMembersNeedingPersonalChannel(seed.team.id, Option.none(), 100),
            ),
          ),
        ),
        Effect.tap(({ results, seed }) =>
          Effect.sync(() => {
            const rows = (results as any[]).filter((r) => r.team_member_id === seed.member.id);
            const buckets = rows.map((r) => r.bucket).sort();
            expect(buckets).toEqual(['other', 'tournament', 'training']);
            expect(buckets).not.toContain('all');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('PersonalEventChannelsRepository — getObsoleteBucketsToDeprovision (B3 atomic switch, plan §6.2)', () => {
  it.effect(
    'one → three: after all three split buckets are provisioned, the obsolete "all" row is returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '422000000000000001',
            'bucket-obsolete-1to3',
            '422050505050505050' as Discord.Snowflake,
          ),
        ),
        // Member starts combined, with a provisioned "all" channel.
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
                .pipe(
                  Effect.andThen(() =>
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member.id,
                      '422111111111111111' as Discord.Snowflake,
                      'events-{discord_id}',
                      'all',
                    ),
                  ),
                ),
            ),
          ),
        ),
        // Flip to split and provision all three new buckets.
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.forEach(
                ['training', 'tournament', 'other'] as const,
                (bucket, i) =>
                  repo
                    .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                    .pipe(
                      Effect.andThen(() =>
                        repo.savePersonalChannelId(
                          seed.team.id,
                          seed.member.id,
                          `42212000000000000${i}` as Discord.Snowflake,
                          'events-{discord_id}',
                          bucket,
                        ),
                      ),
                    ),
                { concurrency: 1 },
              ),
            ),
          ),
        ),
        Effect.bind('obsolete', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getObsoleteBucketsToDeprovision(seed.team.id, 100)),
          ),
        ),
        Effect.tap(({ obsolete, seed }) =>
          Effect.sync(() => {
            const rows = (obsolete as any[]).filter((r) => r.team_member_id === seed.member.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]?.bucket).toBe('all');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'B3 gate: 2 of 3 desired buckets provisioned, third still unreserved → returns NOTHING for this member',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '422000000000000002',
            'bucket-obsolete-gate',
            '422050505050505051' as Discord.Snowflake,
          ),
        ),
        // Provisioned "all" channel (about to become obsolete once the switch completes).
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
                .pipe(
                  Effect.andThen(() =>
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member.id,
                      '422211111111111111' as Discord.Snowflake,
                      'events-{discord_id}',
                      'all',
                    ),
                  ),
                ),
            ),
          ),
        ),
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        // Only training + tournament are FULLY provisioned; "other" is not even reserved.
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.forEach(
                ['training', 'tournament'] as const,
                (bucket, i) =>
                  repo
                    .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                    .pipe(
                      Effect.andThen(() =>
                        repo.savePersonalChannelId(
                          seed.team.id,
                          seed.member.id,
                          `42222000000000000${i}` as Discord.Snowflake,
                          'events-{discord_id}',
                          bucket,
                        ),
                      ),
                    ),
                { concurrency: 1 },
              ),
            ),
          ),
        ),
        Effect.bind('obsolete', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getObsoleteBucketsToDeprovision(seed.team.id, 100)),
          ),
        ),
        Effect.tap(({ obsolete, seed }) =>
          Effect.sync(() => {
            const rows = (obsolete as any[]).filter((r) => r.team_member_id === seed.member.id);
            // The old "all" channel and history must survive until every new bucket
            // exists — a stuck provision degrades to "you keep the channel you had",
            // never to a deletion.
            expect(rows).toHaveLength(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'three → one: after the combined "all" bucket is (re)provisioned, all three split rows are returned as obsolete',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '422000000000000003',
            'bucket-obsolete-3to1',
            '422050505050505052' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.forEach(
                ['training', 'tournament', 'other'] as const,
                (bucket, i) =>
                  repo
                    .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                    .pipe(
                      Effect.andThen(() =>
                        repo.savePersonalChannelId(
                          seed.team.id,
                          seed.member.id,
                          `42232000000000000${i}` as Discord.Snowflake,
                          'events-{discord_id}',
                          bucket,
                        ),
                      ),
                    ),
                { concurrency: 1 },
              ),
            ),
          ),
        ),
        // Flip back to combined, and fully provision the "all" bucket.
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, false)),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
                .pipe(
                  Effect.andThen(() =>
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member.id,
                      '422399999999999999' as Discord.Snowflake,
                      'events-{discord_id}',
                      'all',
                    ),
                  ),
                ),
            ),
          ),
        ),
        Effect.bind('obsolete', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getObsoleteBucketsToDeprovision(seed.team.id, 100)),
          ),
        ),
        Effect.tap(({ obsolete, seed }) =>
          Effect.sync(() => {
            const rows = (obsolete as any[]).filter((r) => r.team_member_id === seed.member.id);
            expect(rows.map((r) => r.bucket).sort()).toEqual(['other', 'tournament', 'training']);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('PersonalEventChannelsRepository — deletePersonalChannel is bucket-scoped and atomic (S3, plan §6.2)', () => {
  it.effect(
    'deletePersonalChannel(team, member, "training") deletes only that row and only that channel\'s messages — the member\'s other channels survive',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '423000000000000001',
            'bucket-delete-scope',
            '423050505050505050' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.forEach(
                ['training', 'tournament'] as const,
                (bucket, i) =>
                  repo
                    .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                    .pipe(
                      Effect.andThen(() =>
                        repo.savePersonalChannelId(
                          seed.team.id,
                          seed.member.id,
                          `42310000000000000${i}` as Discord.Snowflake,
                          'events-{discord_id}',
                          bucket,
                        ),
                      ),
                    ),
                { concurrency: 1 },
              ),
            ),
          ),
        ),
        Effect.bind('deleted', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.deletePersonalChannel(seed.team.id, seed.member.id, 'training'),
            ),
          ),
        ),
        Effect.bind('remainingRows', ({ seed }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe<{ bucket: string }>(
                `SELECT bucket FROM personal_event_channels WHERE team_member_id = '${seed.member.id}'`,
              ),
            ),
          ),
        ),
        Effect.tap(({ deleted, remainingRows }) =>
          Effect.sync(() => {
            expect(Option.getOrNull(deleted)).toBe('423100000000000000');
            const buckets = remainingRows.map((r) => r.bucket);
            expect(buckets).toEqual(['tournament']);
            expect(buckets).not.toContain('training');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'atomicity (S3): after delete, ZERO personal_event_messages rows remain for the deleted channel, checked in one read',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '423000000000000002',
            'bucket-delete-atomic',
            '423050505050505051' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .reservePersonalChannel(seed.team.id, seed.member.id, 'training')
                .pipe(
                  Effect.andThen(() =>
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member.id,
                      '423200000000000000' as Discord.Snowflake,
                      'events-{discord_id}',
                      'training',
                    ),
                  ),
                ),
            ),
          ),
        ),
        // Seed a personal_event_messages row addressed to that channel directly via SQL
        // (no EventsRepository dependency needed for this narrow atomicity check).
        Effect.tap(({ seed }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql
                .unsafe(`
              INSERT INTO personal_event_messages
                (event_id, team_member_id, personal_channel_id, discord_message_id, payload_hash)
              SELECT e.id, '${seed.member.id}', '423200000000000000', '423200000000000001', 'h'
              FROM events e WHERE e.team_id = '${seed.team.id}' LIMIT 1
            `)
                .pipe(Effect.catch(() => Effect.void)),
            ),
          ),
        ),
        Effect.bind('deleted', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.deletePersonalChannel(seed.team.id, seed.member.id, 'training'),
            ),
          ),
        ),
        Effect.bind('check', () =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe<{ pec_count: string; pem_count: string }>(`
              SELECT
                (SELECT COUNT(*) FROM personal_event_channels WHERE discord_channel_id = '423200000000000000')::text AS pec_count,
                (SELECT COUNT(*) FROM personal_event_messages WHERE personal_channel_id = '423200000000000000')::text AS pem_count
            `),
            ),
          ),
        ),
        Effect.tap(({ deleted, check }) =>
          Effect.sync(() => {
            expect(Option.getOrNull(deleted)).toBe('423200000000000000');
            expect(check[0]?.pec_count).toBe('0');
            expect(check[0]?.pem_count).toBe('0');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('PersonalEventChannelsRepository — getChannelsToRename carries bucket (plan §6.2)', () => {
  it.effect('every row returned by getChannelsToRename includes its bucket', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '424000000000000001',
          'bucket-rename',
          '424050505050505050' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => setTeamChannelFormat(seed.team.id, 'events-{discord_id}')),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
              .pipe(
                Effect.andThen(() =>
                  repo.savePersonalChannelId(
                    seed.team.id,
                    seed.member.id,
                    '424111111111111111' as Discord.Snowflake,
                    'events-{discord_id}',
                    'all',
                  ),
                ),
              ),
          ),
        ),
      ),
      // Drift the team format so this row is flagged for rename.
      Effect.tap(({ seed }) => setTeamChannelFormat(seed.team.id, 'club-{discord_id}')),
      Effect.bind('toRename', ({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getChannelsToRename(seed.team.id, 100)),
        ),
      ),
      Effect.tap(({ toRename, seed }) =>
        Effect.sync(() => {
          const row = (toRename as any[]).find((r) => r.team_member_id === seed.member.id);
          expect(row).toBeDefined();
          expect(row?.bucket).toBe('all');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('PersonalEventChannelsRepository — listPersonalChannelsForEvent bucket routing (plan §6.2, the transitional one-row invariant)', () => {
  /** Seed a team + member + an event of the given type, wired to the "all" channel. */
  const seedCombinedMemberWithEvent = (
    suffix: string,
    eventType: 'training' | 'match' | 'tournament' | 'meeting' | 'social' | 'other',
  ) =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          `4250000000000${suffix}`,
          `bucket-route-combined-${suffix}`,
          `42505050505050${suffix}` as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
              .pipe(
                Effect.andThen(() =>
                  repo.savePersonalChannelId(
                    seed.team.id,
                    seed.member.id,
                    `4251${suffix}0000000000` as Discord.Snowflake,
                    'events-{discord_id}',
                    'all',
                  ),
                ),
              ),
          ),
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: seed.team.id,
              eventType,
              title: `Route test ${eventType}`,
              description: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              createdBy: seed.member.id,
            }),
          ),
        ),
      ),
    );

  for (const eventType of [
    'training',
    'match',
    'tournament',
    'meeting',
    'social',
    'other',
  ] as const) {
    it.effect(`combined member → routed to the "all" channel for a "${eventType}" event`, () =>
      seedCombinedMemberWithEvent(eventType, eventType).pipe(
        Effect.bind('rows', ({ seed, event }) =>
          PersonalEventChannelsRepository.asEffect()
            .pipe(Effect.andThen((repo) => repo.listPersonalChannelsForEvent(event.id)))
            .pipe(Effect.map((rows) => rows.filter((r) => r.team_member_id === seed.member.id))),
        ),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(1);
            expect(rows[0]?.personal_channel_id).toBe(`4251${eventType}0000000000`);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  }

  const seedSplitMemberWithBuckets = (
    suffix: string,
    provisionedBuckets: ReadonlyArray<'all' | 'training' | 'tournament' | 'other'>,
  ) =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          `4260000000000${suffix}`,
          `bucket-route-split-${suffix}`,
          `42605050505050${suffix}` as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
      Effect.tap(({ seed }) =>
        PersonalEventChannelsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            Effect.forEach(
              provisionedBuckets,
              (bucket) =>
                repo
                  .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                  .pipe(
                    Effect.andThen(() =>
                      repo.savePersonalChannelId(
                        seed.team.id,
                        seed.member.id,
                        `4261${suffix}${bucket.slice(0, 4)}0000` as Discord.Snowflake,
                        'events-{discord_id}',
                        bucket,
                      ),
                    ),
                  ),
              { concurrency: 1 },
            ),
          ),
        ),
      ),
    );

  const insertEventOfType = (
    teamId: Team.TeamId,
    createdBy: TeamMember.TeamMemberId,
    eventType: 'training' | 'match' | 'tournament' | 'meeting' | 'social' | 'other',
  ) =>
    EventsRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.insertEvent({
          teamId,
          eventType,
          title: `Split route test ${eventType}`,
          description: Option.none(),
          startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
          endAt: Option.none(),
          location: Option.none(),
          ownerGroupId: Option.none(),
          memberGroupId: Option.none(),
          trainingTypeId: Option.none(),
          seriesId: Option.none(),
          createdBy,
        }),
      ),
    );

  const splitRouting: ReadonlyArray<
    [
      eventType: 'training' | 'match' | 'tournament' | 'meeting' | 'social' | 'other',
      expectedBucket: string,
    ]
  > = [
    ['training', 'trai'],
    ['match', 'tour'],
    ['tournament', 'tour'],
    ['meeting', 'othe'],
    ['social', 'othe'],
    ['other', 'othe'],
  ];

  for (const [eventType, expectedBucketPrefix] of splitRouting) {
    it.effect(
      `split member (all three provisioned) → "${eventType}" event routes to the ${expectedBucketPrefix === 'trai' ? 'training' : expectedBucketPrefix === 'tour' ? 'tournament' : 'other'} channel`,
      () =>
        seedSplitMemberWithBuckets(`s${eventType}`, ['training', 'tournament', 'other']).pipe(
          Effect.bind('event', ({ seed }) =>
            insertEventOfType(seed.team.id, seed.member.id, eventType),
          ),
          Effect.bind('rows', ({ seed, event }) =>
            PersonalEventChannelsRepository.asEffect()
              .pipe(Effect.andThen((repo) => repo.listPersonalChannelsForEvent(event.id)))
              .pipe(Effect.map((rows) => rows.filter((r) => r.team_member_id === seed.member.id))),
          ),
          Effect.tap(({ rows }) =>
            Effect.sync(() => {
              expect(rows).toHaveLength(1);
              expect(rows[0]?.personal_channel_id).toBe(
                `4261s${eventType}${expectedBucketPrefix}0000`,
              );
            }),
          ),
          Effect.provide(TestLayer),
        ),
    );
  }

  it.effect(
    'half-provisioned split member (training exists, tournament does not) → NO row for a "match" event; the training channel for a "training" event',
    () =>
      seedSplitMemberWithBuckets('half', ['training']).pipe(
        Effect.bind('matchEvent', ({ seed }) =>
          insertEventOfType(seed.team.id, seed.member.id, 'match'),
        ),
        Effect.bind('trainingEvent', ({ seed }) =>
          insertEventOfType(seed.team.id, seed.member.id, 'training'),
        ),
        Effect.bind('matchRows', ({ seed, matchEvent }) =>
          PersonalEventChannelsRepository.asEffect()
            .pipe(Effect.andThen((repo) => repo.listPersonalChannelsForEvent(matchEvent.id)))
            .pipe(Effect.map((rows) => rows.filter((r) => r.team_member_id === seed.member.id))),
        ),
        Effect.bind('trainingRows', ({ seed, trainingEvent }) =>
          PersonalEventChannelsRepository.asEffect()
            .pipe(Effect.andThen((repo) => repo.listPersonalChannelsForEvent(trainingEvent.id)))
            .pipe(Effect.map((rows) => rows.filter((r) => r.team_member_id === seed.member.id))),
        ),
        Effect.tap(({ matchRows, trainingRows }) =>
          Effect.sync(() => {
            expect(matchRows).toHaveLength(0);
            expect(trainingRows).toHaveLength(1);
            expect(trainingRows[0]?.personal_channel_id).toBe('4261halftrai0000');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'TRANSITIONAL STATE: a member holding an "all" row AND all three split rows simultaneously → listPersonalChannelsForEvent returns EXACTLY ONE row for any event type (two rows would make reconcile double-post)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '427000000000000001',
            'bucket-transitional',
            '427050505050505050' as Discord.Snowflake,
          ),
        ),
        // Provision the "all" row FIRST, while still combined...
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
                .pipe(
                  Effect.andThen(() =>
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member.id,
                      '427111111111111111' as Discord.Snowflake,
                      'events-{discord_id}',
                      'all',
                    ),
                  ),
                ),
            ),
          ),
        ),
        // ...then flip to split and provision all three NEW channels too, WITHOUT
        // deprovisioning "all" — the transitional window the B3 gate deliberately
        // holds open until every new bucket exists.
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.forEach(
                ['training', 'tournament', 'other'] as const,
                (bucket, i) =>
                  repo
                    .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                    .pipe(
                      Effect.andThen(() =>
                        repo.savePersonalChannelId(
                          seed.team.id,
                          seed.member.id,
                          `42721000000000000${i}` as Discord.Snowflake,
                          'events-{discord_id}',
                          bucket,
                        ),
                      ),
                    ),
                { concurrency: 1 },
              ),
            ),
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertEvent({
                teamId: seed.team.id,
                eventType: 'training',
                title: 'Transitional routing test',
                description: Option.none(),
                startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
                endAt: Option.none(),
                location: Option.none(),
                ownerGroupId: Option.none(),
                memberGroupId: Option.none(),
                trainingTypeId: Option.none(),
                seriesId: Option.none(),
                createdBy: seed.member.id,
              }),
            ),
          ),
        ),
        Effect.bind('rows', ({ seed, event }) =>
          PersonalEventChannelsRepository.asEffect()
            .pipe(Effect.andThen((repo) => repo.listPersonalChannelsForEvent(event.id)))
            .pipe(Effect.map((rows) => rows.filter((r) => r.team_member_id === seed.member.id))),
        ),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            // The CASE expression yields exactly one bucket value (the member's
            // CURRENT preference decides which of the two provisioned rows counts) —
            // never two rows for the same member, even while both physically exist.
            expect(rows).toHaveLength(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('PersonalEventChannelsRepository — getGuildsNeedingPersonalProvisioning wakes on a mode flip (plan §6.2)', () => {
  it.effect(
    'a mode flip (one → three) surfaces the guild; the guild drops out once every desired bucket is provisioned and no obsolete bucket remains',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '428000000000000001',
            'bucket-guild-poll',
            '428050505050505050' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ seed }) =>
          setTeamPersonalEventsCategory(seed.team.id, '428999999999999999' as Discord.Snowflake),
        ),
        // Fully provisioned combined member → guild NOT in the needing-provisioning set.
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
                .pipe(
                  Effect.andThen(() =>
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member.id,
                      '428111111111111111' as Discord.Snowflake,
                      'events-{discord_id}',
                      'all',
                    ),
                  ),
                ),
            ),
          ),
        ),
        Effect.bind('guildsBeforeFlip', () =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getGuildsNeedingPersonalProvisioning(1000)),
          ),
        ),
        Effect.tap(({ guildsBeforeFlip, seed }) =>
          Effect.sync(() => {
            expect(guildsBeforeFlip).not.toContain(seed.team.guild_id);
          }),
        ),
        // Flip to split — the desired set changes, the guild must reappear even though
        // nothing about discord_channel_id has changed yet.
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        Effect.bind('guildsAfterFlip', () =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getGuildsNeedingPersonalProvisioning(1000)),
          ),
        ),
        Effect.tap(({ guildsAfterFlip, seed }) =>
          Effect.sync(() => {
            expect(guildsAfterFlip).toContain(seed.team.guild_id);
          }),
        ),
        // Fully provision the three new buckets — the desired set is now satisfied AND
        // (once the B3 gate clears) the obsolete "all" row is gone too.
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.forEach(
                ['training', 'tournament', 'other'] as const,
                (bucket, i) =>
                  repo
                    .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                    .pipe(
                      Effect.andThen(() =>
                        repo.savePersonalChannelId(
                          seed.team.id,
                          seed.member.id,
                          `42821000000000000${i}` as Discord.Snowflake,
                          'events-{discord_id}',
                          bucket,
                        ),
                      ),
                    ),
                { concurrency: 1 },
              ),
            ),
          ),
        ),
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.deletePersonalChannel(seed.team.id, seed.member.id, 'all'),
            ),
          ),
        ),
        Effect.bind('guildsAfterConverge', () =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getGuildsNeedingPersonalProvisioning(1000)),
          ),
        ),
        Effect.tap(({ guildsAfterConverge, seed }) =>
          Effect.sync(() => {
            expect(guildsAfterConverge).not.toContain(seed.team.guild_id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Cycle bounds on this file's four descendant_groups walks.
//
// A cycle in groups.parent_id is corrupt data, not a normal state — but nothing in the
// schema prevents one and moveGroup's check only stops NEW cycles, so pre-existing or
// direct-SQL rows can still have them. Unbounded, the walk never terminates and there is
// no statement_timeout configured in the app.
//
// The second test is the one that matters. getGuildsNeedingPersonalProvisioning takes NO
// team scope — it scans every team — so a single cyclic row in ONE team stalled personal
// channel provisioning for EVERY guild on the instance. SET LOCAL statement_timeout bounds
// the blast radius so an unguarded query fails the assertion rather than wedging the
// (serial) integration suite.
// ---------------------------------------------------------------------------

const wireParentDirectly = (groupId: GroupModel.GroupId, parentId: GroupModel.GroupId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) => sql`UPDATE groups SET parent_id = ${parentId} WHERE id = ${groupId}`),
  );

// Sets BOTH columns on purpose. The poll's outer WHERE requires
// discord_personal_events_category_id IS NOT NULL, so a fixture that sets only the group id
// is filtered out BEFORE the recursive CTE runs -- the test then passes whether or not the
// depth bound exists, which is exactly how this test first passed for the wrong reason.
const setPersonalEventsGroup = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO team_settings (team_id, discord_personal_events_group_id, discord_personal_events_category_id)
        VALUES (${teamId}, ${groupId}, '999000000000000001')
        ON CONFLICT (team_id) DO UPDATE SET
          discord_personal_events_group_id = EXCLUDED.discord_personal_events_group_id,
          discord_personal_events_category_id = EXCLUDED.discord_personal_events_category_id
      `,
    ),
  );

describe('PersonalEventChannelsRepository — descendant walk cycle bounds', () => {
  it.effect(
    'getMembersNeedingPersonalChannel terminates when the scoping group is in a parent_id cycle',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '403000000000000901',
            'cycle-member-1',
            '403090909090909090' as Discord.Snowflake,
          ),
        ),
        Effect.bind('groupA', ({ seed }) => createGroup(seed.team.id, 'Cycle A')),
        Effect.bind('groupB', ({ seed, groupA }) =>
          createGroup(seed.team.id, 'Cycle B', Option.some(groupA.id)),
        ),
        Effect.tap(({ groupA, groupB }) => wireParentDirectly(groupA.id, groupB.id)),
        Effect.tap(({ groupB, seed }) => addGroupMember(groupB.id, seed.member.id)),
        Effect.bind('outcome', ({ seed, groupA }) =>
          Effect.Do.pipe(
            Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
            Effect.bind('repo', () => PersonalEventChannelsRepository.asEffect()),
            Effect.flatMap(({ sql, repo }) =>
              sql
                .withTransaction(
                  Effect.Do.pipe(
                    Effect.tap(() => sql`SET LOCAL statement_timeout = '1500'`),
                    Effect.flatMap(() =>
                      repo.getMembersNeedingPersonalChannel(
                        seed.team.id,
                        Option.some(groupA.id),
                        100,
                      ),
                    ),
                  ),
                )
                .pipe(Effect.exit),
            ),
          ),
        ),
        Effect.tap(({ outcome }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(outcome)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    8000,
  );

  it.effect(
    'getGuildsNeedingPersonalProvisioning terminates — one cyclic team must not stall every guild',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '403000000000000902',
            'cycle-member-2',
            '403090909090909091' as Discord.Snowflake,
          ),
        ),
        Effect.bind('groupA', ({ seed }) => createGroup(seed.team.id, 'Poll cycle A')),
        Effect.bind('groupB', ({ seed, groupA }) =>
          createGroup(seed.team.id, 'Poll cycle B', Option.some(groupA.id)),
        ),
        Effect.tap(({ groupA, groupB }) => wireParentDirectly(groupA.id, groupB.id)),
        Effect.tap(({ groupB, seed }) => addGroupMember(groupB.id, seed.member.id)),
        // Point the team's personal-events group at the cyclic root, so the poll's own
        // correlated walk hits the cycle.
        Effect.tap(({ seed, groupA }) => setPersonalEventsGroup(seed.team.id, groupA.id)),
        Effect.bind('outcome', () =>
          Effect.Do.pipe(
            Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
            Effect.bind('repo', () => PersonalEventChannelsRepository.asEffect()),
            Effect.flatMap(({ sql, repo }) =>
              sql
                .withTransaction(
                  Effect.Do.pipe(
                    Effect.tap(() => sql`SET LOCAL statement_timeout = '1500'`),
                    Effect.flatMap(() => repo.getGuildsNeedingPersonalProvisioning(50)),
                  ),
                )
                .pipe(Effect.exit),
            ),
          ),
        ),
        Effect.tap(({ outcome }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(outcome)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    8000,
  );
});
