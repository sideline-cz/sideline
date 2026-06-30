// NOTE: These tests are written in TDD mode BEFORE the implementation exists.
// They target TrainingGamesRepository which does not yet exist on the server.
// All tests SHOULD FAIL until the developer implements the repository.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { PlayerRatingsRepository } from '~/repositories/PlayerRatingsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
// This import will fail until the implementation is created:
import { TrainingGamesRepository } from '~/repositories/TrainingGamesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TrainingGamesRepository.Default.pipe(Layer.provide(PlayerRatingsRepository.Default)),
  PlayerRatingsRepository.Default,
  ActivityLogsRepository.Default,
  ActivityTypesRepository.Default,
  EventRsvpsRepository.Default,
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers (same pattern as PlayerRatingsRepository.test.ts)
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
        name: 'TG Test Team',
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

const FAR_FUTURE = DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z'));

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId, title = 'TG Event') =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        trainingTypeId: Option.none(),
        eventType: 'training',
        title,
        description: Option.none(),
        startAt: FAR_FUTURE,
        endAt: Option.none(),
        location: Option.none(),
        createdBy,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrainingGamesRepository', () => {
  it.effect('first game for event → round=1', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('300000000000000001', 'tg-user-1')),
      Effect.bind('userId2', () => createUser('300000000000000002', 'tg-user-2')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('300000000300000001' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('event', ({ team, member1 }) =>
        createEvent(team.id, member1.id, 'Round 1 Event'),
      ),
      Effect.bind('tgRepo', () => TrainingGamesRepository.asEffect()),
      Effect.bind('game', ({ tgRepo, team, event, member1, member2 }) =>
        tgRepo.insertGame({
          teamId: team.id,
          eventId: event.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'teamA',
          submittedBy: Option.some(member1.id),
        }),
      ),
      Effect.tap(({ game }) =>
        Effect.sync(() => {
          expect(game.round).toBe(1);
          expect(game.outcome).toBe('teamA');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('second game for same event → round=2; third → round=3', () =>
    Effect.Do.pipe(
      Effect.bind('userId1', () => createUser('300000000000000011', 'tg-round-1')),
      Effect.bind('userId2', () => createUser('300000000000000012', 'tg-round-2')),
      Effect.bind('userId3', () => createUser('300000000000000013', 'tg-round-3')),
      Effect.bind('team', ({ userId1 }) =>
        createTeam('300000000300000002' as Discord.Snowflake, userId1),
      ),
      Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
      Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
      Effect.bind('member3', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
      Effect.bind('event', ({ team, member1 }) =>
        createEvent(team.id, member1.id, 'Sequential Rounds Event'),
      ),
      Effect.bind('tgRepo', () => TrainingGamesRepository.asEffect()),
      Effect.bind('game1', ({ tgRepo, team, event, member1, member2 }) =>
        tgRepo.insertGame({
          teamId: team.id,
          eventId: event.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member2.id],
          outcome: 'draw',
          submittedBy: Option.none(),
        }),
      ),
      Effect.bind('game2', ({ tgRepo, team, event, member2, member3 }) =>
        tgRepo.insertGame({
          teamId: team.id,
          eventId: event.id,
          teamAMemberIds: [member2.id],
          teamBMemberIds: [member3.id],
          outcome: 'teamB',
          submittedBy: Option.none(),
        }),
      ),
      Effect.bind('game3', ({ tgRepo, team, event, member1, member3 }) =>
        tgRepo.insertGame({
          teamId: team.id,
          eventId: event.id,
          teamAMemberIds: [member1.id],
          teamBMemberIds: [member3.id],
          outcome: 'teamA',
          submittedBy: Option.none(),
        }),
      ),
      Effect.tap(({ game1, game2, game3 }) =>
        Effect.sync(() => {
          expect(game1.round).toBe(1);
          expect(game2.round).toBe(2);
          expect(game3.round).toBe(3);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // NOTE: Effect.all with concurrency:'unbounded' runs on a single JS event loop thread and does
  // NOT open real concurrent DB sessions, so it cannot validate advisory-lock serialization.
  // True-concurrency serialization is enforced by the per-event DB advisory lock +
  // UNIQUE(event_id, round) constraint in the schema.  The test below only verifies
  // that two sequential inserts within the same Effect fiber increment rounds correctly
  // and that both rows persist — it is intentionally named "sequential" to reflect this.
  // If a second DB connection can be obtained from the test harness in the future, update
  // this to drive two genuinely concurrent sessions to exercise the advisory lock.
  it.effect(
    'two sequential insertGame on same event → distinct rounds 1 and 2, both persisted',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId1', () => createUser('300000000000000021', 'tg-par-1')),
        Effect.bind('userId2', () => createUser('300000000000000022', 'tg-par-2')),
        Effect.bind('userId3', () => createUser('300000000000000023', 'tg-par-3')),
        Effect.bind('userId4', () => createUser('300000000000000024', 'tg-par-4')),
        Effect.bind('team', ({ userId1 }) =>
          createTeam('300000000300000003' as Discord.Snowflake, userId1),
        ),
        Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.bind('member3', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
        Effect.bind('member4', ({ team, userId4 }) => addTeamMember(team.id, userId4)),
        Effect.bind('event', ({ team, member1 }) =>
          createEvent(team.id, member1.id, 'Sequential Insert Event'),
        ),
        Effect.bind('tgRepo', () => TrainingGamesRepository.asEffect()),
        // Insert two games sequentially on the same event
        Effect.bind('results', ({ tgRepo, team, event, member1, member2, member3, member4 }) =>
          Effect.all(
            [
              tgRepo.insertGame({
                teamId: team.id,
                eventId: event.id,
                teamAMemberIds: [member1.id],
                teamBMemberIds: [member2.id],
                outcome: 'teamA',
                submittedBy: Option.none(),
              }),
              tgRepo.insertGame({
                teamId: team.id,
                eventId: event.id,
                teamAMemberIds: [member3.id],
                teamBMemberIds: [member4.id],
                outcome: 'draw',
                submittedBy: Option.none(),
              }),
            ],
            // sequential — all runs items in order within the same fiber
            { concurrency: 1 },
          ),
        ),
        Effect.tap(({ results }) =>
          Effect.sync(() => {
            const rounds = results.map((g) => g.round).sort((a, b) => a - b);
            expect(rounds).toEqual([1, 2]);
          }),
        ),
        // Both games persist
        Effect.bind('listedGames', ({ tgRepo, team, event }) =>
          tgRepo.listGamesByEvent(team.id, event.id),
        ),
        Effect.tap(({ listedGames }) =>
          Effect.sync(() => {
            expect(listedGames).toHaveLength(2);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'insertGame writes player_rating_history rows with game_id = inserted game id for all participants',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId1', () => createUser('300000000000000031', 'tg-hist-1')),
        Effect.bind('userId2', () => createUser('300000000000000032', 'tg-hist-2')),
        Effect.bind('team', ({ userId1 }) =>
          createTeam('300000000300000004' as Discord.Snowflake, userId1),
        ),
        Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.bind('event', ({ team, member1 }) =>
          createEvent(team.id, member1.id, 'Hist GameId Event'),
        ),
        Effect.bind('tgRepo', () => TrainingGamesRepository.asEffect()),
        Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
        Effect.bind('game', ({ tgRepo, team, event, member1, member2 }) =>
          tgRepo.insertGame({
            teamId: team.id,
            eventId: event.id,
            teamAMemberIds: [member1.id],
            teamBMemberIds: [member2.id],
            outcome: 'teamA',
            submittedBy: Option.none(),
          }),
        ),
        Effect.bind('history1', ({ ratings, team, member1 }) =>
          ratings.findHistoryByMember(team.id, member1.id, 10),
        ),
        Effect.bind('history2', ({ ratings, team, member2 }) =>
          ratings.findHistoryByMember(team.id, member2.id, 10),
        ),
        Effect.tap(({ game, history1, history2 }) =>
          Effect.sync(() => {
            expect(history1).toHaveLength(1);
            expect(history2).toHaveLength(1);
            expect(Option.isSome(history1[0].game_id)).toBe(true);
            expect(Option.getOrThrow(history1[0].game_id)).toBe(game.id);
            expect(Option.isSome(history2[0].game_id)).toBe(true);
            expect(Option.getOrThrow(history2[0].game_id)).toBe(game.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Happy-path witness: proves insertGame DOES write training_games + participant rows on success.
  // Without this, the atomic-rollback test's emptiness would be vacuous (the DB is clean anyway).
  it.effect(
    'insertGame happy path — persists training_games row and participant rows in the database',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId1', () => createUser('300000000000000061', 'tg-happy-1')),
        Effect.bind('userId2', () => createUser('300000000000000062', 'tg-happy-2')),
        Effect.bind('team', ({ userId1 }) =>
          createTeam('300000000300000007' as Discord.Snowflake, userId1),
        ),
        Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.bind('event', ({ team, member1 }) =>
          createEvent(team.id, member1.id, 'Happy Path Event'),
        ),
        Effect.bind('tgRepo', () => TrainingGamesRepository.asEffect()),
        Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
        Effect.bind('game', ({ tgRepo, team, event, member1, member2 }) =>
          tgRepo.insertGame({
            teamId: team.id,
            eventId: event.id,
            teamAMemberIds: [member1.id],
            teamBMemberIds: [member2.id],
            outcome: 'draw',
            submittedBy: Option.none(),
          }),
        ),
        // Verify training_games row exists
        Effect.bind('tgRows', ({ sql, event }) =>
          sql<{ id: string }[]>`SELECT id FROM training_games WHERE event_id = ${event.id}`.pipe(
            Effect.map((rows) => rows),
          ),
        ),
        // Verify participant rows exist
        Effect.bind('participantRows', ({ sql, game }) =>
          sql<
            {
              team_member_id: string;
            }[]
          >`SELECT team_member_id FROM training_game_participants WHERE training_game_id = ${game.id}`.pipe(
            Effect.map((rows) => rows),
          ),
        ),
        Effect.tap(({ tgRows, participantRows }) =>
          Effect.sync(() => {
            expect(tgRows).toHaveLength(1);
            // Two participants (one per side)
            expect(participantRows).toHaveLength(2);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'insertGame is atomic: FK failure for unknown member → no training_games row, no participants, no rating/history rows',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId1', () => createUser('300000000000000041', 'tg-atom-1')),
        Effect.bind('team', ({ userId1 }) =>
          createTeam('300000000300000005' as Discord.Snowflake, userId1),
        ),
        Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('event', ({ team, member1 }) =>
          createEvent(team.id, member1.id, 'Atomic Rollback Event'),
        ),
        Effect.bind('tgRepo', () => TrainingGamesRepository.asEffect()),
        Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
        Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
        // Use a nonexistent member id that cannot satisfy the FK — this forces a failure
        // AFTER the training_games row has been inserted but BEFORE all participants are written,
        // proving the entire transaction (game row + participants + Elo history) is rolled back.
        Effect.bind('exit', ({ tgRepo, team, event, member1 }) =>
          tgRepo
            .insertGame({
              teamId: team.id,
              eventId: event.id,
              teamAMemberIds: [member1.id],
              // Force FK failure with a nonexistent member id
              teamBMemberIds: ['00000000-0000-4000-ffff-000000000000' as TeamMember.TeamMemberId],
              outcome: 'teamA',
              submittedBy: Option.none(),
            })
            .pipe(Effect.exit),
        ),
        // No training_games row for the event
        Effect.bind('tgRows', ({ sql, event }) =>
          sql<{ id: string }[]>`SELECT id FROM training_games WHERE event_id = ${event.id}`.pipe(
            Effect.map((rows) => rows),
          ),
        ),
        // No participant rows at all (training_game_participants is scoped by training_game_id,
        // but since training_games was rolled back there should be no orphans)
        Effect.bind('participantRows', ({ sql, event }) =>
          sql<
            {
              training_game_id: string;
            }[]
          >`SELECT tgp.training_game_id FROM training_game_participants tgp
               JOIN training_games tg ON tg.id = tgp.training_game_id
               WHERE tg.event_id = ${event.id}`.pipe(Effect.map((rows) => rows)),
        ),
        Effect.bind('teamRatings', ({ ratings, team }) => ratings.getTeamRatings(team.id)),
        Effect.bind('history1', ({ ratings, team, member1 }) =>
          ratings.findHistoryByMember(team.id, member1.id, 10),
        ),
        Effect.tap(({ exit, tgRows, participantRows, teamRatings, history1 }) =>
          Effect.sync(() => {
            // The insert must have failed
            expect(Exit.isFailure(exit)).toBe(true);
            // No training_games row persisted (atomic rollback)
            expect(tgRows).toHaveLength(0);
            // No participant rows persisted
            expect(participantRows).toHaveLength(0);
            // No rating rows persisted for this team
            expect(teamRatings).toHaveLength(0);
            // No history rows for member1
            expect(history1).toHaveLength(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'listGamesByEvent returns games ordered by round ASC with correct side A/B membership',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId1', () => createUser('300000000000000051', 'tg-list-1')),
        Effect.bind('userId2', () => createUser('300000000000000052', 'tg-list-2')),
        Effect.bind('userId3', () => createUser('300000000000000053', 'tg-list-3')),
        Effect.bind('userId4', () => createUser('300000000000000054', 'tg-list-4')),
        Effect.bind('team', ({ userId1 }) =>
          createTeam('300000000300000006' as Discord.Snowflake, userId1),
        ),
        Effect.bind('member1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('member2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.bind('member3', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
        Effect.bind('member4', ({ team, userId4 }) => addTeamMember(team.id, userId4)),
        Effect.bind('event', ({ team, member1 }) =>
          createEvent(team.id, member1.id, 'List Games Event'),
        ),
        Effect.bind('tgRepo', () => TrainingGamesRepository.asEffect()),
        // Insert two games sequentially — round 1 then round 2
        Effect.tap(({ tgRepo, team, event, member1, member2 }) =>
          tgRepo.insertGame({
            teamId: team.id,
            eventId: event.id,
            teamAMemberIds: [member1.id],
            teamBMemberIds: [member2.id],
            outcome: 'teamA',
            submittedBy: Option.none(),
          }),
        ),
        Effect.tap(({ tgRepo, team, event, member3, member4 }) =>
          tgRepo.insertGame({
            teamId: team.id,
            eventId: event.id,
            teamAMemberIds: [member3.id],
            teamBMemberIds: [member4.id],
            outcome: 'draw',
            submittedBy: Option.none(),
          }),
        ),
        Effect.bind('games', ({ tgRepo, team, event }) =>
          tgRepo.listGamesByEvent(team.id, event.id),
        ),
        Effect.tap(({ games, member1, member2, member3, member4 }) =>
          Effect.sync(() => {
            expect(games).toHaveLength(2);
            // Ordered by round ASC
            expect(games[0].round).toBe(1);
            expect(games[1].round).toBe(2);
            // Side A/B correct for round 1
            expect(games[0].teamA).toContain(member1.id);
            expect(games[0].teamB).toContain(member2.id);
            expect(games[0].outcome).toBe('teamA');
            // Side A/B correct for round 2
            expect(games[1].teamA).toContain(member3.id);
            expect(games[1].teamB).toContain(member4.id);
            expect(games[1].outcome).toBe('draw');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
