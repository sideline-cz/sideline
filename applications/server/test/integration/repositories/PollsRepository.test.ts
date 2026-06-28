// TDD mode — written BEFORE the implementation exists.
// Tests will fail until PollsRepository is implemented.
// Requires a running PostgreSQL (Docker) + migrations applied.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Poll, Team, TeamMember, User } from '@sideline/domain';
import { PollRpcModels } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { PollsRepository } from '~/repositories/PollsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  PollsRepository.Default,
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
        name: 'Poll Test Team',
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

const createPoll = (
  teamId: Team.TeamId,
  guildId: Discord.Snowflake,
  channelId: Discord.Snowflake,
  createdBy: TeamMember.TeamMemberId,
  options: string[] = ['Option A', 'Option B'],
  multiple = false,
  timezone = 'UTC',
) =>
  PollsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.createPoll({
        teamId,
        guildId,
        channelId,
        question: 'Test poll question?',
        options,
        multiple,
        allowedRoleId: Option.none(),
        deadline: Option.none(),
        timezone,
        createdBy,
      }),
    ),
  );

const castVote = (
  pollId: Poll.PollId,
  optionId: Poll.PollOptionId,
  teamMemberId: TeamMember.TeamMemberId,
  teamId: Team.TeamId,
) =>
  PollsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.castVote({ pollId, optionId, teamMemberId, teamId })),
  );

const addOption = (
  pollId: Poll.PollId,
  label: string,
  teamMemberId: TeamMember.TeamMemberId,
  teamId: Team.TeamId,
  memberRoleIds: ReadonlyArray<Discord.Snowflake> = [],
  isManagerOrCreator = false,
) =>
  PollsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addOption({ pollId, label, teamMemberId, memberRoleIds, teamId, isManagerOrCreator }),
    ),
  );

const closePoll = (pollId: Poll.PollId, teamId: Team.TeamId) =>
  PollsRepository.asEffect().pipe(Effect.andThen((repo) => repo.closePoll({ pollId, teamId })));

const findPollView = (pollId: Poll.PollId, viewer: Option.Option<TeamMember.TeamMemberId>) =>
  PollsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findPollView(pollId, viewer)));

// ---------------------------------------------------------------------------
// Tests — multi-choice mode
// ---------------------------------------------------------------------------

describe('PollsRepository — multi-choice mode', () => {
  it.effect('vote A then vote B → both recorded; my_option_ids=[A,B]; actions added/added', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000001', 'voter-multi-1');
      const team = yield* createTeam('510000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '510000000000000010' as Discord.Snowflake,
        member.id,
        ['Option A', 'Option B'],
        true,
      );

      const optionA = poll.options[0].option_id;
      const optionB = poll.options[1].option_id;

      const resultA = yield* castVote(poll.poll_id, optionA, member.id, team.id);
      expect(resultA.action).toBe('added');
      expect(resultA.my_option_ids).toContain(optionA);

      const resultB = yield* castVote(poll.poll_id, optionB, member.id, team.id);
      expect(resultB.action).toBe('added');
      expect(resultB.my_option_ids).toContain(optionA);
      expect(resultB.my_option_ids).toContain(optionB);
      expect(resultB.my_option_ids).toHaveLength(2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('re-click A after A+B → action=removed; my_option_ids=[B]', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000002', 'voter-multi-2');
      const team = yield* createTeam('511000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '511000000000000010' as Discord.Snowflake,
        member.id,
        ['Option A', 'Option B'],
        true,
      );

      const optionA = poll.options[0].option_id;
      const optionB = poll.options[1].option_id;

      yield* castVote(poll.poll_id, optionA, member.id, team.id);
      yield* castVote(poll.poll_id, optionB, member.id, team.id);
      const removeA = yield* castVote(poll.poll_id, optionA, member.id, team.id);

      expect(removeA.action).toBe('removed');
      expect(removeA.my_option_ids).not.toContain(optionA);
      expect(removeA.my_option_ids).toContain(optionB);
      expect(removeA.my_option_ids).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('remove all votes in multi → my_option_ids=[]', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000003', 'voter-multi-3');
      const team = yield* createTeam('512000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '512000000000000010' as Discord.Snowflake,
        member.id,
        ['Option A', 'Option B'],
        true,
      );

      const optionA = poll.options[0].option_id;
      const optionB = poll.options[1].option_id;

      yield* castVote(poll.poll_id, optionA, member.id, team.id);
      yield* castVote(poll.poll_id, optionB, member.id, team.id);
      yield* castVote(poll.poll_id, optionA, member.id, team.id); // remove A
      const removeB = yield* castVote(poll.poll_id, optionB, member.id, team.id); // remove B

      expect(removeB.action).toBe('removed');
      expect(removeB.my_option_ids).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'option-belongs guard in multi mode — option from different poll → PollOptionNotFound',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('500000000000000004', 'voter-multi-guard');
        const team = yield* createTeam('513000000000000001' as Discord.Snowflake, userId);
        const member = yield* addTeamMember(team.id, userId);

        const poll1 = yield* createPoll(
          team.id,
          team.guild_id,
          '513000000000000010' as Discord.Snowflake,
          member.id,
          ['A', 'B'],
          true,
        );
        const poll2 = yield* createPoll(
          team.id,
          team.guild_id,
          '513000000000000011' as Discord.Snowflake,
          member.id,
          ['X', 'Y'],
          true,
        );

        // Try to vote on poll2 using an option_id from poll1
        const optionFromPoll1 = poll1.options[0].option_id;
        const result = yield* castVote(poll2.poll_id, optionFromPoll1, member.id, team.id).pipe(
          Effect.result,
        );

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('PollOptionNotFound');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('lazy-close in multi mode — castVote on expired poll → PollClosed', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000005', 'voter-multi-lazy');
      const team = yield* createTeam('514000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '514000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        true,
      );

      // Manually close the poll via closePoll
      yield* closePoll(poll.poll_id, team.id);

      const optionA = poll.options[0].option_id;
      const result = yield* castVote(poll.poll_id, optionA, member.id, team.id).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollClosed');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'concurrent same (member,option) multi clicks — deterministic toggle nets zero votes',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('500000000000000006', 'voter-multi-concurrent');
        const team = yield* createTeam('515000000000000001' as Discord.Snowflake, userId);
        const member = yield* addTeamMember(team.id, userId);
        const poll = yield* createPoll(
          team.id,
          team.guild_id,
          '515000000000000010' as Discord.Snowflake,
          member.id,
          ['A', 'B'],
          true,
        );

        const optionA = poll.options[0].option_id;

        // Fire two identical votes concurrently — FOR UPDATE lock serializes them:
        // first adds the vote, second sees it and removes it (toggle), netting zero rows.
        const results = yield* Effect.all(
          [
            castVote(poll.poll_id, optionA, member.id, team.id).pipe(Effect.result),
            castVote(poll.poll_id, optionA, member.id, team.id).pipe(Effect.result),
          ],
          { concurrency: 'unbounded' },
        );

        // Both calls must succeed
        const successes = results.filter((r) => r._tag === 'Success').length;
        expect(successes).toBe(2);

        // The two actions must be exactly one 'added' and one 'removed' (deterministic toggle)
        const actions: string[] = [];
        for (const r of results) {
          if (r._tag === 'Success') {
            actions.push(r.success.action);
          }
        }
        actions.sort();
        expect(actions).toEqual(['added', 'removed']);

        // Net result: vote toggled off → vote_count = 0
        const view = yield* findPollView(poll.poll_id, Option.some(member.id));
        expect(Option.isSome(view)).toBe(true);
        const pollView = Option.getOrThrow(view);
        const optAView = pollView.options.find((o) => o.option_id === optionA);
        expect(optAView?.vote_count).toBe(0);

        // my_option_ids must be empty for that member
        expect(pollView.my_option_ids).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Tests — single-choice mode
// ---------------------------------------------------------------------------

describe('PollsRepository — single-choice mode', () => {
  it.effect('vote A → action=counted; my_option_ids=[A]; one row', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000010', 'voter-single-1');
      const team = yield* createTeam('520000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '520000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        false,
      );

      const optionA = poll.options[0].option_id;
      const result = yield* castVote(poll.poll_id, optionA, member.id, team.id);

      expect(result.action).toBe('counted');
      expect(result.my_option_ids).toEqual([optionA]);

      // Verify DB state: total_votes = 1
      const view = yield* findPollView(poll.poll_id, Option.some(member.id));
      const pollView = Option.getOrThrow(view);
      expect(pollView.total_votes).toBe(1);
      const optAView = pollView.options.find((o) => o.option_id === optionA);
      expect(optAView?.vote_count).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('vote A then vote B → action=moved; my_option_ids=[B]; A gone (one row max)', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000011', 'voter-single-2');
      const team = yield* createTeam('521000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '521000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        false,
      );

      const optionA = poll.options[0].option_id;
      const optionB = poll.options[1].option_id;

      yield* castVote(poll.poll_id, optionA, member.id, team.id);
      const resultB = yield* castVote(poll.poll_id, optionB, member.id, team.id);

      expect(resultB.action).toBe('moved');
      expect(resultB.my_option_ids).toEqual([optionB]);
      expect(resultB.my_option_ids).not.toContain(optionA);

      // Verify DB state: only one vote row (option B), A removed
      const view = yield* findPollView(poll.poll_id, Option.some(member.id));
      const pollView = Option.getOrThrow(view);
      expect(pollView.total_votes).toBe(1);
      const optAView = pollView.options.find((o) => o.option_id === optionA);
      const optBView = pollView.options.find((o) => o.option_id === optionB);
      expect(optAView?.vote_count).toBe(0);
      expect(optBView?.vote_count).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('vote A then vote A again → action=retracted; my_option_ids=[]', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000012', 'voter-single-3');
      const team = yield* createTeam('522000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '522000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        false,
      );

      const optionA = poll.options[0].option_id;

      yield* castVote(poll.poll_id, optionA, member.id, team.id);
      const retract = yield* castVote(poll.poll_id, optionA, member.id, team.id);

      expect(retract.action).toBe('retracted');
      expect(retract.my_option_ids).toHaveLength(0);

      const view = yield* findPollView(poll.poll_id, Option.some(member.id));
      const pollView = Option.getOrThrow(view);
      expect(pollView.total_votes).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('option-belongs guard in single mode → PollOptionNotFound', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000013', 'voter-single-guard');
      const team = yield* createTeam('523000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);

      const poll1 = yield* createPoll(
        team.id,
        team.guild_id,
        '523000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        false,
      );
      const poll2 = yield* createPoll(
        team.id,
        team.guild_id,
        '523000000000000011' as Discord.Snowflake,
        member.id,
        ['X', 'Y'],
        false,
      );

      const optionFromPoll1 = poll1.options[0].option_id;
      const result = yield* castVote(poll2.poll_id, optionFromPoll1, member.id, team.id).pipe(
        Effect.result,
      );

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollOptionNotFound');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('lazy-close in single mode — closed poll → PollClosed on castVote', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000014', 'voter-single-lazy');
      const team = yield* createTeam('524000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '524000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        false,
      );

      yield* closePoll(poll.poll_id, team.id);

      const optionA = poll.options[0].option_id;
      const result = yield* castVote(poll.poll_id, optionA, member.id, team.id).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollClosed');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('concurrent castVote in single mode — exactly one vote row survives', () =>
    Effect.gen(function* () {
      const userId1 = yield* createUser('500000000000000015', 'voter-single-conc-1');
      const userId2 = yield* createUser('500000000000000016', 'voter-single-conc-2');
      const team = yield* createTeam('525000000000000001' as Discord.Snowflake, userId1);
      const member1 = yield* addTeamMember(team.id, userId1);
      const member2 = yield* addTeamMember(team.id, userId2);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '525000000000000010' as Discord.Snowflake,
        member1.id,
        ['A', 'B'],
        false,
      );

      const optionA = poll.options[0].option_id;
      const optionB = poll.options[1].option_id;

      // Two members voting on the same single-choice poll concurrently
      const results = yield* Effect.all(
        [
          castVote(poll.poll_id, optionA, member1.id, team.id).pipe(Effect.result),
          castVote(poll.poll_id, optionB, member2.id, team.id).pipe(Effect.result),
        ],
        { concurrency: 'unbounded' },
      );

      const successes = results.filter((r) => r._tag === 'Success').length;
      expect(successes).toBe(2); // both members can vote independently

      const view = yield* findPollView(poll.poll_id, Option.none());
      const pollView = Option.getOrThrow(view);
      // Total unique voters = 2
      expect(pollView.total_votes).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Tests — addOption
// ---------------------------------------------------------------------------

describe('PollsRepository — addOption', () => {
  it.effect('addOption happy path — position increments; option appears in view', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000020', 'adder-1');
      const team = yield* createTeam('530000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '530000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        false,
      );

      const addResult = yield* addOption(poll.poll_id, 'C', member.id, team.id);

      expect(addResult.option_id).toBeDefined();
      expect(addResult.view.options).toHaveLength(3);
      const addedOption = addResult.view.options.find((o) => o.label === 'C');
      expect(addedOption).toBeDefined();
      // position should be 2 (0-based index for the 3rd option)
      expect(addedOption?.position).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addOption duplicate label (case-insensitive) → PollDuplicateOption', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000021', 'adder-dup');
      const team = yield* createTeam('531000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '531000000000000010' as Discord.Snowflake,
        member.id,
        ['Alpha', 'Beta'],
        false,
      );

      const result = yield* addOption(poll.poll_id, 'alpha', member.id, team.id).pipe(
        Effect.result,
      );

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollDuplicateOption');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addOption at 10-option cap → PollOptionLimitReached', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000022', 'adder-cap');
      const team = yield* createTeam('532000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const options10 = Array.from({ length: 10 }, (_, i) => `Option${i + 1}`);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '532000000000000010' as Discord.Snowflake,
        member.id,
        options10,
        false,
      );

      const result = yield* addOption(poll.poll_id, 'EleventhOption', member.id, team.id).pipe(
        Effect.result,
      );

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollOptionLimitReached');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'addOption gate — allowed_role_id is set; member without that role → PollAddOptionForbidden',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('500000000000000023', 'adder-gate');
        const team = yield* createTeam('533000000000000001' as Discord.Snowflake, userId);
        const member = yield* addTeamMember(team.id, userId);

        // Create poll with allowed_role_id restriction
        const poll = yield* PollsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.createPoll({
              teamId: team.id,
              guildId: team.guild_id,
              channelId: '533000000000000010' as Discord.Snowflake,
              question: 'Gated poll?',
              options: ['Yes', 'No'],
              multiple: false,
              allowedRoleId: Option.some('533000000000000020' as Discord.Snowflake),
              deadline: Option.none(),
              timezone: 'UTC',
              createdBy: member.id,
            }),
          ),
        );

        // Member has empty role list (no allowed role) and is not a manager/creator
        const result = yield* addOption(poll.poll_id, 'Maybe', member.id, team.id, []).pipe(
          Effect.result,
        );

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('PollAddOptionForbidden');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addOption gate — member has allowed role in memberRoleIds → succeeds', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000024', 'adder-gate-ok');
      const team = yield* createTeam('534000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const ALLOWED_ROLE = '534000000000000020' as Discord.Snowflake;

      const poll = yield* PollsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.createPoll({
            teamId: team.id,
            guildId: team.guild_id,
            channelId: '534000000000000010' as Discord.Snowflake,
            question: 'Gated poll?',
            options: ['Yes', 'No'],
            multiple: false,
            allowedRoleId: Option.some(ALLOWED_ROLE),
            deadline: Option.none(),
            timezone: 'UTC',
            createdBy: member.id,
          }),
        ),
      );

      // Member carries the allowed role
      const result = yield* addOption(poll.poll_id, 'Maybe', member.id, team.id, [ALLOWED_ROLE]);

      expect(result.option_id).toBeDefined();
      expect(result.view.options).toHaveLength(3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addOption gate — isManagerOrCreator=true bypasses allowed_role_id restriction', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000026', 'adder-manager-bypass');
      const team = yield* createTeam('536000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const ALLOWED_ROLE = '536000000000000020' as Discord.Snowflake;

      const poll = yield* PollsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.createPoll({
            teamId: team.id,
            guildId: team.guild_id,
            channelId: '536000000000000010' as Discord.Snowflake,
            question: 'Gated poll for manager bypass?',
            options: ['Yes', 'No'],
            multiple: false,
            allowedRoleId: Option.some(ALLOWED_ROLE),
            deadline: Option.none(),
            timezone: 'UTC',
            createdBy: member.id,
          }),
        ),
      );

      // Member has NO allowed role but isManagerOrCreator=true — must succeed
      const result = yield* addOption(
        poll.poll_id,
        'Maybe',
        member.id,
        team.id,
        [], // no roles
        true, // isManagerOrCreator bypass
      );

      expect(result.option_id).toBeDefined();
      expect(result.view.options).toHaveLength(3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addOption on closed poll → PollClosed', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000025', 'adder-closed');
      const team = yield* createTeam('535000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '535000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        false,
      );

      yield* closePoll(poll.poll_id, team.id);

      const result = yield* addOption(poll.poll_id, 'New', member.id, team.id).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollClosed');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Tests — createPoll timezone resolution
// ---------------------------------------------------------------------------

describe('PollsRepository — createPoll timezone resolution', () => {
  it.effect('Europe/Prague 12:00 deadline → UTC 11:00 (CET offset = UTC+1 in winter)', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000030', 'tz-creator');
      const team = yield* createTeam('540000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);

      const poll = yield* PollsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.createPoll({
            teamId: team.id,
            guildId: team.guild_id,
            channelId: '540000000000000010' as Discord.Snowflake,
            question: 'Timezone test?',
            options: ['Yes', 'No'],
            multiple: false,
            allowedRoleId: Option.none(),
            // 2099-01-15 12:00 Prague time = 2099-01-15 11:00 UTC (CET = UTC+1)
            deadline: Option.some({ y: 2099, mo: 1, d: 15, h: 12, mi: 0 }),
            timezone: 'Europe/Prague',
            createdBy: member.id,
          }),
        ),
      );

      expect(Option.isSome(poll.deadline)).toBe(true);
      if (Option.isSome(poll.deadline)) {
        // Deadline UTC hours should be 11 (12:00 Prague CET = 11:00 UTC)
        const deadlineUtc = Option.getOrThrow(poll.deadline);
        // The deadline is a DateTimeUtc; extract the hour
        const deadlineStr = deadlineUtc.toString();
        // January in Prague = UTC+1, so 12:00 Prague = 11:00 UTC
        expect(deadlineStr).toContain('T11:00');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('createPoll with already-past deadline → PollDeadlineInPast', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000031', 'tz-past');
      const team = yield* createTeam('541000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);

      const result = yield* PollsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.createPoll({
            teamId: team.id,
            guildId: team.guild_id,
            channelId: '541000000000000010' as Discord.Snowflake,
            question: 'Past deadline?',
            options: ['Yes', 'No'],
            multiple: false,
            allowedRoleId: Option.none(),
            // Deadline is in the past
            deadline: Option.some({ y: 2020, mo: 1, d: 1, h: 0, mi: 0 }),
            timezone: 'UTC',
            createdBy: member.id,
          }),
        ),
        Effect.result,
      );

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollDeadlineInPast');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Tests — closePoll
// ---------------------------------------------------------------------------

describe('PollsRepository — closePoll', () => {
  it.effect('closePoll happy path → status=closed in returned view', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000040', 'closer-1');
      const team = yield* createTeam('550000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '550000000000000010' as Discord.Snowflake,
        member.id,
      );

      const closedView = yield* closePoll(poll.poll_id, team.id);

      expect(closedView.status).toBe('closed');
      expect(closedView.poll_id).toBe(poll.poll_id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('closePoll idempotent — closing already-closed poll → still returns closed view', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000041', 'closer-idem');
      const team = yield* createTeam('551000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '551000000000000010' as Discord.Snowflake,
        member.id,
      );

      yield* closePoll(poll.poll_id, team.id);
      const secondClose = yield* closePoll(poll.poll_id, team.id);

      expect(secondClose.status).toBe('closed');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('closePoll non-existent poll → PollNotFound', () =>
    Effect.gen(function* () {
      const result = yield* closePoll(
        'ffffffff-ffff-ffff-ffff-ffffffffffff' as Poll.PollId,
        'ffffffff-ffff-ffff-ffff-000000000000' as Team.TeamId,
      ).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('PollNotFound');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Tests — findPollView
// ---------------------------------------------------------------------------

describe('PollsRepository — findPollView', () => {
  it.effect('findPollView with viewer — my_option_ids populated correctly', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000050', 'viewer-1');
      const team = yield* createTeam('560000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '560000000000000010' as Discord.Snowflake,
        member.id,
        ['A', 'B'],
        true, // multi
      );

      const optionA = poll.options[0].option_id;
      const optionB = poll.options[1].option_id;

      yield* castVote(poll.poll_id, optionA, member.id, team.id);
      yield* castVote(poll.poll_id, optionB, member.id, team.id);

      const view = yield* findPollView(poll.poll_id, Option.some(member.id));
      expect(Option.isSome(view)).toBe(true);
      const pollView = Option.getOrThrow(view);
      expect(pollView.my_option_ids).toContain(optionA);
      expect(pollView.my_option_ids).toContain(optionB);
      expect(pollView.my_option_ids).toHaveLength(2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('findPollView without viewer → my_option_ids is empty array', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('500000000000000051', 'viewer-noviewer');
      const team = yield* createTeam('561000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '561000000000000010' as Discord.Snowflake,
        member.id,
      );

      const optionA = poll.options[0].option_id;
      yield* castVote(poll.poll_id, optionA, member.id, team.id);

      const view = yield* findPollView(poll.poll_id, Option.none());
      expect(Option.isSome(view)).toBe(true);
      const pollView = Option.getOrThrow(view);
      expect(pollView.my_option_ids).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('findPollView for non-existent poll → Option.none()', () =>
    Effect.gen(function* () {
      const view = yield* findPollView(
        'ffffffff-ffff-ffff-ffff-ffffffffffff' as Poll.PollId,
        Option.none(),
      );
      expect(Option.isNone(view)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'vote_count not inflated by cartesian product — multiple voters, each option count is exact',
    () =>
      Effect.gen(function* () {
        // REGRESSION TEST for: pv_total × pv_opt cartesian product inflating vote_count.
        // When total_votes > 1, the old COUNT(pv_opt.id) was multiplied by total_votes.
        // With 3 voters on A and 2 voters on B, the old query returned:
        //   optA.vote_count = 3 × 5 = 15 (wrong), optB.vote_count = 2 × 5 = 10 (wrong)
        // The fix (COUNT DISTINCT) must return:
        //   optA.vote_count = 3 (correct), optB.vote_count = 2 (correct), total_votes = 5
        const userId1 = yield* createUser('500000000000000060', 'count-voter-1');
        const userId2 = yield* createUser('500000000000000061', 'count-voter-2');
        const userId3 = yield* createUser('500000000000000062', 'count-voter-3');
        const userId4 = yield* createUser('500000000000000063', 'count-voter-4');
        const userId5 = yield* createUser('500000000000000064', 'count-voter-5');

        const team = yield* createTeam('570000000000000001' as Discord.Snowflake, userId1);
        const member1 = yield* addTeamMember(team.id, userId1);
        const member2 = yield* addTeamMember(team.id, userId2);
        const member3 = yield* addTeamMember(team.id, userId3);
        const member4 = yield* addTeamMember(team.id, userId4);
        const member5 = yield* addTeamMember(team.id, userId5);

        // Single-choice poll with options A and B
        const poll = yield* createPoll(
          team.id,
          team.guild_id,
          '570000000000000010' as Discord.Snowflake,
          member1.id,
          ['Option A', 'Option B'],
          false,
        );

        const optionA = poll.options[0].option_id;
        const optionB = poll.options[1].option_id;

        // 3 voters choose A, 2 voters choose B → total_votes=5
        yield* castVote(poll.poll_id, optionA, member1.id, team.id);
        yield* castVote(poll.poll_id, optionA, member2.id, team.id);
        yield* castVote(poll.poll_id, optionA, member3.id, team.id);
        yield* castVote(poll.poll_id, optionB, member4.id, team.id);
        yield* castVote(poll.poll_id, optionB, member5.id, team.id);

        const view = yield* findPollView(poll.poll_id, Option.none());
        expect(Option.isSome(view)).toBe(true);
        const pollView = Option.getOrThrow(view);

        // total_votes must be 5 distinct voters (not inflated)
        expect(pollView.total_votes).toBe(5);

        const optAView = pollView.options.find((o) => o.option_id === optionA);
        const optBView = pollView.options.find((o) => o.option_id === optionB);

        // vote_count per option must be exact — NOT multiplied by total_votes
        expect(optAView?.vote_count).toBe(3);
        expect(optBView?.vote_count).toBe(2);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Tests — findPollVoters (TDD mode — implementation does not exist yet)
// ---------------------------------------------------------------------------
// NOTE: These tests reference repo.findPollVoters which is not yet implemented.
// They will fail until the method is added to PollsRepository.
// ---------------------------------------------------------------------------

const findPollVoters = (pollId: Poll.PollId, teamId: Team.TeamId) =>
  PollsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findPollVoters(pollId, teamId)));

describe('PollsRepository — findPollVoters', () => {
  it.effect(
    'groups voters by option; both vote_count and voters correct; total_votes = distinct participants',
    () =>
      Effect.gen(function* () {
        const userId1 = yield* createUser('600000000000000001', 'voter-fv-1');
        const userId2 = yield* createUser('600000000000000002', 'voter-fv-2');
        const team = yield* createTeam('610000000000000001' as Discord.Snowflake, userId1);
        const member1 = yield* addTeamMember(team.id, userId1);
        const member2 = yield* addTeamMember(team.id, userId2);
        const poll = yield* createPoll(
          team.id,
          team.guild_id,
          '610000000000000010' as Discord.Snowflake,
          member1.id,
          ['Option A', 'Option B'],
          false,
        );

        const optionA = poll.options[0].option_id;
        const optionB = poll.options[1].option_id;

        yield* castVote(poll.poll_id, optionA, member1.id, team.id);
        yield* castVote(poll.poll_id, optionB, member2.id, team.id);

        const result = yield* findPollVoters(poll.poll_id, team.id);
        expect(Option.isSome(result)).toBe(true);
        const view = Option.getOrThrow(result);

        // Structural type check — view must be a proper PollVotersView instance
        expect(view).toBeInstanceOf(PollRpcModels.PollVotersView);

        // total_votes = 2 distinct participants
        expect(view.total_votes).toBe(2);

        const optA = view.options.find((o: any) => o.option_id === optionA);
        const optB = view.options.find((o: any) => o.option_id === optionB);

        expect(optA).toBeDefined();
        expect(optB).toBeDefined();
        expect(optA?.vote_count).toBe(1);
        expect(optA?.voters).toHaveLength(1);
        expect(optB?.vote_count).toBe(1);
        expect(optB?.voters).toHaveLength(1);

        // Each voter entry must be a proper PollVoter instance
        const voterA = optA?.voters[0];
        expect(voterA).toBeInstanceOf(PollRpcModels.PollVoter);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('zero-voter option → vote_count 0, voters []', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('600000000000000010', 'voter-fv-zero');
      const team = yield* createTeam('611000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '611000000000000010' as Discord.Snowflake,
        member.id,
        ['Option A', 'Option B'],
        false,
      );

      const optionA = poll.options[0].option_id;

      // Only vote for option A; option B gets no votes
      yield* castVote(poll.poll_id, optionA, member.id, team.id);

      const result = yield* findPollVoters(poll.poll_id, team.id);
      const view = Option.getOrThrow(result);

      const optB = view.options.find((o: any) => o.option_id === poll.options[1].option_id);
      expect(optB?.vote_count).toBe(0);
      expect(optB?.voters).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'multiple-choice: a member voting two options appears in both, counted once in total_votes',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('600000000000000020', 'voter-fv-multi');
        const team = yield* createTeam('612000000000000001' as Discord.Snowflake, userId);
        const member = yield* addTeamMember(team.id, userId);
        const poll = yield* createPoll(
          team.id,
          team.guild_id,
          '612000000000000010' as Discord.Snowflake,
          member.id,
          ['Option A', 'Option B'],
          true, // multiple choice
        );

        const optionA = poll.options[0].option_id;
        const optionB = poll.options[1].option_id;

        // Single member votes for both options
        yield* castVote(poll.poll_id, optionA, member.id, team.id);
        yield* castVote(poll.poll_id, optionB, member.id, team.id);

        const result = yield* findPollVoters(poll.poll_id, team.id);
        const view = Option.getOrThrow(result);

        // Member counted once in total_votes (distinct participants)
        expect(view.total_votes).toBe(1);

        // But the member appears in both options' voters lists
        const optA = view.options.find((o: any) => o.option_id === optionA);
        const optB = view.options.find((o: any) => o.option_id === optionB);
        expect(optA?.voters).toHaveLength(1);
        expect(optB?.voters).toHaveLength(1);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '>60 voters in an option → voters.length capped at 60, vote_count equals true total (75)',
    () =>
      Effect.gen(function* () {
        // We need 75 unique voters all voting for option A
        const creatorUserId = yield* createUser('613000000000000000', 'creator-fv-cap');
        const teamReal = yield* createTeam(
          '614000000000000001' as Discord.Snowflake,
          creatorUserId,
        );
        const creatorMember = yield* addTeamMember(teamReal.id, creatorUserId);
        const poll = yield* createPoll(
          teamReal.id,
          teamReal.guild_id,
          '614000000000000010' as Discord.Snowflake,
          creatorMember.id,
          ['Option A', 'Option B'],
          false,
        );

        const optionA = poll.options[0].option_id;

        // Create 75 voters and cast votes for option A
        const memberIds: TeamMember.TeamMemberId[] = [];
        for (let i = 1; i <= 75; i++) {
          const discordId = `6130000000000${String(i).padStart(5, '0')}`;
          const uid = yield* createUser(discordId, `cap-voter-${i}`);
          const m = yield* addTeamMember(teamReal.id, uid);
          memberIds.push(m.id);
        }

        // All 75 vote for option A
        for (const memberId of memberIds) {
          yield* castVote(poll.poll_id, optionA, memberId, teamReal.id);
        }

        const result = yield* findPollVoters(poll.poll_id, teamReal.id);
        const view = Option.getOrThrow(result);

        const optA = view.options.find((o: any) => o.option_id === optionA);
        expect(optA).toBeDefined();
        // true vote_count = 75 (all voters)
        expect(optA?.vote_count).toBe(75);
        // voters list capped at 60
        expect(optA?.voters).toHaveLength(60);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'voter name parts mapped from users columns; NULL discord_nickname/name → Option.none',
    () =>
      Effect.gen(function* () {
        const userId = yield* createUser('620000000000000001', 'named-voter-fv');
        const team = yield* createTeam('621000000000000001' as Discord.Snowflake, userId);
        const member = yield* addTeamMember(team.id, userId);
        const poll = yield* createPoll(
          team.id,
          team.guild_id,
          '621000000000000010' as Discord.Snowflake,
          member.id,
          ['Option A', 'Option B'],
          false,
        );

        const optionA = poll.options[0].option_id;
        yield* castVote(poll.poll_id, optionA, member.id, team.id);

        const result = yield* findPollVoters(poll.poll_id, team.id);
        const view = Option.getOrThrow(result);

        const optA = view.options.find((o: any) => o.option_id === optionA);
        expect(optA?.voters).toHaveLength(1);

        const voter = optA?.voters[0];
        expect(voter).toBeDefined();
        if (voter === undefined) return;
        // discord_id must be present and equal the seeded value
        expect(Option.isSome(voter.discord_id)).toBe(true);
        if (Option.isSome(voter.discord_id)) {
          expect(voter.discord_id.value).toBe('620000000000000001');
        }
        // nickname is NULL → Option.none
        expect(Option.isNone(voter.nickname)).toBe(true);
        // username should be 'named-voter-fv'
        expect(Option.isSome(voter.username)).toBe(true);
        if (Option.isSome(voter.username)) {
          expect(voter.username.value).toBe('named-voter-fv');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('wrong team → Option.none (team scoping)', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('630000000000000001', 'scoping-fv');
      const team = yield* createTeam('631000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '631000000000000010' as Discord.Snowflake,
        member.id,
        ['Option A', 'Option B'],
        false,
      );

      const optionA = poll.options[0].option_id;
      yield* castVote(poll.poll_id, optionA, member.id, team.id);

      // Query with wrong teamId → should return Option.none
      const wrongTeamId = 'ffffffff-ffff-ffff-ffff-000000000099' as Team.TeamId;
      const result = yield* findPollVoters(poll.poll_id, wrongTeamId);
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('missing poll → Option.none', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('640000000000000001', 'missing-fv');
      const team = yield* createTeam('641000000000000001' as Discord.Snowflake, userId);

      const result = yield* findPollVoters(
        'ffffffff-ffff-ffff-ffff-ffffffffffff' as Poll.PollId,
        team.id,
      );
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('closed poll still returns voters, status closed', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('650000000000000001', 'closed-fv');
      const team = yield* createTeam('651000000000000001' as Discord.Snowflake, userId);
      const member = yield* addTeamMember(team.id, userId);
      const poll = yield* createPoll(
        team.id,
        team.guild_id,
        '651000000000000010' as Discord.Snowflake,
        member.id,
        ['Option A', 'Option B'],
        false,
      );

      const optionA = poll.options[0].option_id;
      yield* castVote(poll.poll_id, optionA, member.id, team.id);
      yield* closePoll(poll.poll_id, team.id);

      const result = yield* findPollVoters(poll.poll_id, team.id);
      expect(Option.isSome(result)).toBe(true);
      const view = Option.getOrThrow(result);
      expect(view.status).toBe('closed');
      const optA = view.options.find((o: any) => o.option_id === optionA);
      expect(optA?.vote_count).toBe(1);
      expect(optA?.voters).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'mixed cardinality: member1 votes A+B, member2 votes A only → total_votes=2, optA.voters=2, optB.voters=1',
    () =>
      Effect.gen(function* () {
        const userId1 = yield* createUser('660000000000000001', 'mixed-fv-1');
        const userId2 = yield* createUser('660000000000000002', 'mixed-fv-2');
        const team = yield* createTeam('661000000000000001' as Discord.Snowflake, userId1);
        const member1 = yield* addTeamMember(team.id, userId1);
        const member2 = yield* addTeamMember(team.id, userId2);
        const poll = yield* createPoll(
          team.id,
          team.guild_id,
          '661000000000000010' as Discord.Snowflake,
          member1.id,
          ['Option A', 'Option B'],
          true, // multiple choice so both members can vote for multiple options
        );

        const optionA = poll.options[0].option_id;
        const optionB = poll.options[1].option_id;

        // member1 votes for both A and B
        yield* castVote(poll.poll_id, optionA, member1.id, team.id);
        yield* castVote(poll.poll_id, optionB, member1.id, team.id);
        // member2 votes for A only
        yield* castVote(poll.poll_id, optionA, member2.id, team.id);

        const result = yield* findPollVoters(poll.poll_id, team.id);
        const view = Option.getOrThrow(result);

        // 2 distinct participants → total_votes = 2
        expect(view.total_votes).toBe(2);

        const optA = view.options.find((o: any) => o.option_id === optionA);
        const optB = view.options.find((o: any) => o.option_id === optionB);

        expect(optA).toBeDefined();
        expect(optB).toBeDefined();
        // Option A: 2 vote_count, 2 voters
        expect(optA?.vote_count).toBe(2);
        expect(optA?.voters).toHaveLength(2);
        // Option B: 1 vote_count, 1 voter (member1 only)
        expect(optB?.vote_count).toBe(1);
        expect(optB?.voters).toHaveLength(1);
      }).pipe(Effect.provide(TestLayer)),
  );
});
