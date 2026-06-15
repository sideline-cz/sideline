import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Elo } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { PlayerRatingsRepository } from '~/repositories/PlayerRatingsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  PlayerRatingsRepository.Default,
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
        overview_channel_id: Option.none(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlayerRatingsRepository', () => {
  it.effect('getOrInitMany seeds at DEFAULT_RATING/0 and is idempotent', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('100000000000000001', 'player1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('111111111111111111' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
      Effect.bind('rows', ({ ratings, team, member }) =>
        ratings.getOrInitMany(team.id, [member.id]),
      ),
      Effect.tap(({ rows, member }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(1);
          const row = rows[0];
          expect(row.team_member_id).toBe(member.id);
          expect(row.rating).toBe(Elo.DEFAULT_RATING);
          expect(row.games_played).toBe(0);
          expect(row.wins).toBe(0);
          expect(row.losses).toBe(0);
          expect(row.draws).toBe(0);
        }),
      ),
      // Call again — should be idempotent
      Effect.bind('rows2', ({ ratings, team, member }) =>
        ratings.getOrInitMany(team.id, [member.id]),
      ),
      Effect.tap(({ rows2 }) =>
        Effect.sync(() => {
          expect(rows2).toHaveLength(1);
          expect(rows2[0].rating).toBe(Elo.DEFAULT_RATING);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('applyGameUpdates updates ratings and increments W/L/D correctly', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('100000000000000011', 'player-a')),
      Effect.bind('userId2', () => createUser('100000000000000012', 'player-b')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('222222222222222222' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
      Effect.tap(({ ratings, team, member1, member2 }) =>
        ratings.applyGameUpdates({
          teamId: team.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'teamA',
          submittedBy: Option.some(member1.id),
        }),
      ),
      Effect.bind('teamRatings', ({ ratings, team }) => ratings.getTeamRatings(team.id)),
      Effect.tap(({ teamRatings, member1, member2 }) =>
        Effect.sync(() => {
          const r1 = teamRatings.find((r) => r.team_member_id === member1.id);
          const r2 = teamRatings.find((r) => r.team_member_id === member2.id);

          expect(r1).toBeDefined();
          expect(r2).toBeDefined();

          // teamA (member1) won
          expect(r1?.games_played).toBe(1);
          expect(r1?.wins).toBe(1);
          expect(r1?.losses).toBe(0);
          expect(r1?.draws).toBe(0);
          expect(r1?.rating).toBeGreaterThan(1200);

          // teamB (member2) lost
          expect(r2?.games_played).toBe(1);
          expect(r2?.wins).toBe(0);
          expect(r2?.losses).toBe(1);
          expect(r2?.draws).toBe(0);
          expect(r2?.rating).toBeLessThan(1200);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('applyGameUpdates writes one history row per player with correct fields', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('100000000000000021', 'hist-player-a')),
      Effect.bind('userId2', () => createUser('100000000000000022', 'hist-player-b')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('333333333333333333' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
      Effect.tap(({ ratings, team, member1, member2 }) =>
        ratings.applyGameUpdates({
          teamId: team.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'draw',
          submittedBy: Option.some(member1.id),
        }),
      ),
      Effect.bind('history1', ({ ratings, team, member1 }) =>
        ratings.findHistoryByMember(team.id, member1.id, 10),
      ),
      Effect.bind('history2', ({ ratings, team, member2 }) =>
        ratings.findHistoryByMember(team.id, member2.id, 10),
      ),
      Effect.tap(({ history1, history2, member1 }) =>
        Effect.sync(() => {
          expect(history1).toHaveLength(1);
          expect(history2).toHaveLength(1);

          const h1 = history1[0];
          expect(h1.result).toBe('draw');
          expect(h1.rating_before).toBe(1200);
          expect(h1.rating_after).toBe(h1.rating_before + h1.delta);
          expect(Option.isSome(h1.submitted_by)).toBe(true);
          expect(Option.getOrThrow(h1.submitted_by)).toBe(member1.id);
          expect(Option.isNone(h1.game_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('getTeamRatings returns entries ordered by rating DESC', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('100000000000000031', 'order-player-a')),
      Effect.bind('userId2', () => createUser('100000000000000032', 'order-player-b')),
      Effect.bind('userId3', () => createUser('100000000000000033', 'order-player-c')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('444444444444444444' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('member3', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
      Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
      Effect.bind('_init', ({ ratings, team, member1, member2, member3 }) =>
        ratings.getOrInitMany(team.id, [member1.id, member2.id, member3.id]),
      ),
      // member1 wins a game (gets highest rating), member3 loses
      Effect.tap(({ ratings, team, member1, member3 }) =>
        ratings.applyGameUpdates({
          teamId: team.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member3.id],
          outcome: 'teamA',
          submittedBy: Option.some(member1.id),
        }),
      ),
      Effect.bind('teamRatings', ({ ratings, team }) => ratings.getTeamRatings(team.id)),
      Effect.tap(({ teamRatings }) =>
        Effect.sync(() => {
          // Ratings should be ordered DESC
          for (let i = 0; i < teamRatings.length - 1; i++) {
            expect(teamRatings[i].rating).toBeGreaterThanOrEqual(teamRatings[i + 1].rating);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findHistoryByMember returns entries ordered created_at DESC, id DESC', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('100000000000000041', 'hist-order-a')),
      Effect.bind('userId2', () => createUser('100000000000000042', 'hist-order-b')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('555555555555555555' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
      Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
      // Apply two games sequentially (distinct timestamps)
      Effect.tap(({ ratings, team, member1, member2 }) =>
        ratings.applyGameUpdates({
          teamId: team.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'teamA',
          submittedBy: Option.none(),
        }),
      ),
      Effect.tap(({ ratings, team, member1, member2 }) =>
        ratings.applyGameUpdates({
          teamId: team.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'teamB',
          submittedBy: Option.none(),
        }),
      ),
      // Insert two history rows with an identical created_at to exercise the id DESC tiebreaker
      Effect.tap(({ sql, team, member1 }) => {
        const fixedTs = '2020-01-01T00:00:00.000Z';
        return sql`
          INSERT INTO player_rating_history
            (team_id, team_member_id, rating_before, rating_after, delta, result, game_id, submitted_by, created_at)
          VALUES
            (${team.id}, ${member1.id}, 900, 910, 10, 'win', NULL, NULL, ${fixedTs}::timestamptz),
            (${team.id}, ${member1.id}, 910, 920, 10, 'win', NULL, NULL, ${fixedTs}::timestamptz)
        `.pipe(Effect.asVoid);
      }),
      Effect.bind('history', ({ ratings, team, member1 }) =>
        ratings.findHistoryByMember(team.id, member1.id, 10),
      ),
      Effect.tap(({ history }) =>
        Effect.sync(() => {
          // Most recent entry is first (DESC order)
          expect(history.length).toBeGreaterThanOrEqual(4);
          // The most recent games should be first (created_at DESC)
          for (let i = 0; i < history.length - 1; i++) {
            expect(history[i].created_at.getTime()).toBeGreaterThanOrEqual(
              history[i + 1].created_at.getTime(),
            );
          }
          // The two same-timestamp rows inserted last are the oldest; they appear at the end.
          // Find the equal-timestamp pair among them and assert id DESC tiebreaker.
          const sameTsRows = history.filter((h) =>
            h.created_at.toISOString().startsWith('2020-01-01'),
          );
          expect(sameTsRows).toHaveLength(2);
          // id DESC: first sameTsRow id must be greater than second
          expect(sameTsRows[0].id > sameTsRows[1].id).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('getMemberRating returns previousRating and lastDelta from latest history', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('100000000000000051', 'prev-rating-a')),
      Effect.bind('userId2', () => createUser('100000000000000052', 'prev-rating-b')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('666666666666666666' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
      Effect.tap(({ ratings, team, member1, member2 }) =>
        ratings.applyGameUpdates({
          teamId: team.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'teamA',
          submittedBy: Option.none(),
        }),
      ),
      Effect.bind('memberRating', ({ ratings, team, member1 }) =>
        ratings.getMemberRating(team.id, member1.id),
      ),
      Effect.tap(({ memberRating }) =>
        Effect.sync(() => {
          expect(Option.isSome(memberRating)).toBe(true);
          const r = Option.getOrThrow(memberRating);
          // previousRating should be 1200 (the rating_before of the latest history entry)
          expect(Option.isSome(r.prev_rating)).toBe(true);
          expect(Option.getOrThrow(r.prev_rating)).toBe(1200);
          // lastDelta should be positive (won)
          expect(Option.isSome(r.last_delta)).toBe(true);
          expect(Option.getOrThrow(r.last_delta)).toBeGreaterThan(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('FK cascade deletes ratings and history when team_member is deleted', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('100000000000000061', 'cascade-a')),
      Effect.bind('userId2', () => createUser('100000000000000062', 'cascade-b')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('777777777777777777' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
      Effect.bind('members', () => TeamMembersRepository.asEffect()),
      Effect.tap(({ ratings, team, member1, member2 }) =>
        ratings.applyGameUpdates({
          teamId: team.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'teamA',
          submittedBy: Option.none(),
        }),
      ),
      // Hard-delete member1 — this exercises the FK cascade
      Effect.tap(({ members, member1 }) => members.hardDelete(member1.id)),
      // After hard delete, player_ratings row and history rows must be gone (FK cascade)
      Effect.bind('ratingAfterDelete', ({ ratings, team, member1 }) =>
        ratings.getMemberRating(team.id, member1.id),
      ),
      Effect.bind('historyAfterDelete', ({ ratings, team, member1 }) =>
        ratings.findHistoryByMember(team.id, member1.id, 10),
      ),
      Effect.tap(({ ratingAfterDelete, historyAfterDelete }) =>
        Effect.sync(() => {
          expect(Option.isNone(ratingAfterDelete)).toBe(true);
          expect(historyAfterDelete).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
