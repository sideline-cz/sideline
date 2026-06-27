// NOTE: TDD mode — written BEFORE the implementation exists.
// Tests will fail to import/compile until PollsRpcLive is implemented.
// The `poll:manage` permission gate applies to CreatePoll and ClosePoll only.
// CastVote requires only team membership (no permission gate).
// AddOption: the raw member_role_ids array is forwarded to the repo as-is;
//   the gate is enforced SERVER-SIDE inside the repo tx, never a boolean here.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team, TeamMember } from '@sideline/domain';
import { type Poll, PollRpcGroup, PollRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { PollsRepository } from '~/repositories/PollsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { PollsRpcLive } from '~/rpc/poll/index.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '700000000000000001' as Discord.Snowflake;
const UNKNOWN_GUILD_ID = '700000000000000099' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000070' as Team.TeamId;
const MANAGER_DISCORD_ID = '700000000000000010' as Discord.Snowflake;
const MEMBER_DISCORD_ID = '700000000000000011' as Discord.Snowflake;
const NON_MEMBER_DISCORD_ID = '700000000000000012' as Discord.Snowflake;
const MANAGER_MEMBER_ID = '00000000-0000-0000-0000-000000000071' as TeamMember.TeamMemberId;
const MEMBER_MEMBER_ID = '00000000-0000-0000-0000-000000000072' as TeamMember.TeamMemberId;
const CHANNEL_ID = '700000000000000020' as Discord.Snowflake;
const POLL_ID = '00000000-0000-0000-0000-000000000080' as Poll.PollId;
const OPTION_ID_A = '00000000-0000-0000-0000-000000000081' as Poll.PollOptionId;
const OPTION_ID_B = '00000000-0000-0000-0000-000000000082' as Poll.PollOptionId;
const ROLE_ID = '700000000000000030' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makePollOptionView = (
  optionId: Poll.PollOptionId,
  label: string,
  position: number,
  voteCount = 0,
): PollRpcModels.PollOptionView =>
  new PollRpcModels.PollOptionView({
    option_id: optionId,
    label,
    position,
    vote_count: voteCount,
  });

const makePollView = (
  pollId: Poll.PollId = POLL_ID,
  status: Poll.PollStatus = 'open',
  multiple = false,
  myOptionIds: Poll.PollOptionId[] = [],
): PollRpcModels.PollView =>
  new PollRpcModels.PollView({
    poll_id: pollId,
    discord_channel_id: CHANNEL_ID,
    discord_message_id: Option.none(),
    question: 'Test question?',
    status,
    multiple,
    allowed_role_id: Option.none(),
    deadline: Option.none(),
    total_votes: myOptionIds.length,
    options: [
      makePollOptionView(OPTION_ID_A, 'Option A', 0),
      makePollOptionView(OPTION_ID_B, 'Option B', 1),
    ],
    my_option_ids: myOptionIds,
  });

// ---------------------------------------------------------------------------
// In-memory stores (reset between tests)
// ---------------------------------------------------------------------------

type CastVoteCall = {
  pollId: Poll.PollId;
  optionId: Poll.PollOptionId;
  teamMemberId: TeamMember.TeamMemberId;
  teamId: Team.TeamId;
};

type AddOptionCall = {
  pollId: Poll.PollId;
  label: string;
  teamMemberId: TeamMember.TeamMemberId;
  memberRoleIds: ReadonlyArray<Discord.Snowflake>;
  teamId: Team.TeamId;
  isManagerOrCreator: boolean;
};

type ClosePollCall = {
  pollId: Poll.PollId;
  teamId: Team.TeamId;
};

let createPollCalls: Array<unknown>;
let castVoteCalls: Array<CastVoteCall>;
let addOptionCalls: Array<AddOptionCall>;
let closePollCalls: Array<ClosePollCall>;
let pollsStore: Map<Poll.PollId, PollRpcModels.PollView>;
let castVoteActionOverride: PollRpcModels.CastVoteResult['action'] | null;

const resetStores = () => {
  createPollCalls = [];
  castVoteCalls = [];
  addOptionCalls = [];
  closePollCalls = [];
  pollsStore = new Map();
  castVoteActionOverride = null;

  pollsStore.set(POLL_ID, makePollView());
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockTeamsRepository = Layer.succeed(TeamsRepository, {
  findById: (_id: Team.TeamId) => Effect.succeed(Option.none()),
  findByGuildId: (guildId: Discord.Snowflake) => {
    if (guildId === GUILD_ID) {
      return Effect.succeed(
        Option.some({
          id: TEAM_ID,
          name: 'Poll Test Team',
          guild_id: GUILD_ID,
          created_by: 'user-1',
          created_at: DateTime.nowUnsafe(),
          updated_at: DateTime.nowUnsafe(),
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamMembersRepository = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (_teamId: Team.TeamId) => Effect.succeed(Option.none()),
  findMembershipByDiscordAndTeam: (discordId: Discord.Snowflake, teamId: Team.TeamId) => {
    if (teamId !== TEAM_ID) return Effect.succeed(Option.none());
    if (discordId === MANAGER_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: MANAGER_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-manager',
          active: true,
          role_names: ['Captain'],
          permissions: ['poll:manage'] as string[],
        }),
      );
    }
    if (discordId === MEMBER_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: MEMBER_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-member',
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
  addMember: () => Effect.die(new Error('Not implemented')),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockTeamSettingsRepository = Layer.succeed(TeamSettingsRepository, {
  findByTeamId: (_teamId: Team.TeamId) =>
    Effect.succeed(Option.some({ timezone: 'Europe/Prague' }) as any),
} as any);

const MockPollsRepository = Layer.succeed(PollsRepository, {
  createPoll: (input: unknown) => {
    createPollCalls.push(input);
    return Effect.succeed(makePollView());
  },
  saveMessageId: (_pollId: Poll.PollId, _messageId: Discord.Snowflake) => Effect.void,
  findPollView: (
    pollId: Poll.PollId,
    _viewer: Option.Option<TeamMember.TeamMemberId>,
    _teamId: Option.Option<Team.TeamId>,
  ) =>
    Effect.succeed(
      pollsStore.get(pollId) !== undefined ? Option.some(pollsStore.get(pollId)) : Option.none(),
    ),
  castVote: (input: CastVoteCall) => {
    castVoteCalls.push(input);
    const action = castVoteActionOverride ?? 'counted';
    const view = pollsStore.get(input.pollId) ?? makePollView();
    return Effect.succeed(
      new PollRpcModels.CastVoteResult({
        view,
        my_option_ids: [input.optionId] as Poll.PollOptionId[],
        action,
      }),
    );
  },
  addOption: (input: AddOptionCall) => {
    addOptionCalls.push(input);
    const view = pollsStore.get(input.pollId) ?? makePollView();
    const optionId = OPTION_ID_A;
    return Effect.succeed(
      new PollRpcModels.AddOptionResult({
        option_id: optionId,
        view,
      }),
    );
  },
  closePoll: (input: ClosePollCall) => {
    closePollCalls.push(input);
    const view = makePollView(input.pollId, 'closed');
    pollsStore.set(input.pollId, view);
    return Effect.succeed(view);
  },
} as any);

const TestLayer = PollsRpcLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      MockTeamsRepository,
      MockTeamMembersRepository,
      MockTeamSettingsRepository,
      MockPollsRepository,
    ),
  ),
);

// ---------------------------------------------------------------------------
// RPC call helper
// ---------------------------------------------------------------------------

const callRpc = (method: string, payload: Record<string, unknown>) =>
  Effect.scoped(
    (RpcTest.makeClient(PollRpcGroup.PollRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap((rpc: any) => rpc[method](payload) as Effect.Effect<any, any, any>),
    ),
  ).pipe(Effect.provide(TestLayer));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  castVoteCalls = [];
  addOptionCalls = [];
  closePollCalls = [];
  createPollCalls = [];
});

// ---------------------------------------------------------------------------
// Poll/CreatePoll
// ---------------------------------------------------------------------------

describe('Poll/CreatePoll RPC — permission gate', () => {
  itEffect.effect('unknown guild_id → PollGuildNotFound', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: UNKNOWN_GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Pizza or sushi?',
      options_raw: 'Pizza;Sushi',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollGuildNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member discord_user_id → PollNotMember', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Pizza or sushi?',
      options_raw: 'Pizza;Sushi',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('member without poll:manage permission → PollForbidden (permission gate)', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Pizza or sushi?',
      options_raw: 'Pizza;Sushi',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollForbidden');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('manager with poll:manage creates poll → returns PollView', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Pizza or sushi?',
      options_raw: 'Pizza;Sushi',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          expect(view).toBeInstanceOf(PollRpcModels.PollView);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Poll/CreatePoll — option validation
// ---------------------------------------------------------------------------

describe('Poll/CreatePoll RPC — option validation', () => {
  itEffect.effect('too few options (1) → PollTooFewOptions', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Only one?',
      options_raw: 'OnlyOne',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollTooFewOptions');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('too many options (11) → PollTooManyOptions', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `Option${i + 1}`).join(';');
    return callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Too many?',
      options_raw: tooMany,
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollTooManyOptions');
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  itEffect.effect('duplicate option (case-insensitive) → PollDuplicateOption', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Dupes?',
      options_raw: 'Pizza;pizza',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollDuplicateOption');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('option label longer than 80 chars → PollOptionTooLong', () => {
    const longLabel = 'A'.repeat(81);
    return callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Long option?',
      options_raw: `${longLabel};ValidOption`,
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollOptionTooLong');
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  itEffect.effect('exactly 80 char label + valid second option → succeeds', () => {
    const label80 = 'A'.repeat(80);
    return callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Exactly 80?',
      options_raw: `${label80};ValidOption`,
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.none(),
    }).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          expect(view).toBeInstanceOf(PollRpcModels.PollView);
        }),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// Poll/CreatePoll — deadline validation
// ---------------------------------------------------------------------------

describe('Poll/CreatePoll RPC — deadline validation', () => {
  itEffect.effect('unparseable deadline string → PollInvalidDeadline', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'When?',
      options_raw: 'Yes;No',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.some('not-a-date'),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollInvalidDeadline');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('deadline in the past → PollDeadlineInPast (repo raises it)', () => {
    const MockPollsRepoWithPastDeadline = Layer.succeed(PollsRepository, {
      createPoll: (_input: unknown) => Effect.fail(new PollRpcModels.PollDeadlineInPast()),
      saveMessageId: () => Effect.void,
      findPollView: () => Effect.succeed(Option.none()),
      castVote: () => Effect.die(new Error('Not used')),
      addOption: () => Effect.die(new Error('Not used')),
      closePoll: () => Effect.die(new Error('Not used')),
    } as any);

    const layerWithPast = PollsRpcLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          MockTeamsRepository,
          MockTeamMembersRepository,
          MockTeamSettingsRepository,
          MockPollsRepoWithPastDeadline,
        ),
      ),
    );

    return callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Past?',
      options_raw: 'Yes;No',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.some('2020-01-01 12:00'),
    }).pipe(
      Effect.provide(layerWithPast),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollDeadlineInPast');
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  itEffect.effect('valid future deadline (YYYY-MM-DD HH:mm) → succeeds, createPoll called', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Future?',
      options_raw: 'Yes;No',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.some('2099-12-31 23:59'),
    }).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          expect(view).toBeInstanceOf(PollRpcModels.PollView);
          expect(createPollCalls).toHaveLength(1);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Poll/CastVote — all 5 actions + my_option_ids + multiple propagated
// ---------------------------------------------------------------------------

describe('Poll/CastVote RPC — actions and my_option_ids', () => {
  itEffect.effect('unknown guild_id → PollGuildNotFound', () =>
    callRpc('Poll/CastVote', {
      guild_id: UNKNOWN_GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      poll_id: POLL_ID,
      option_id: OPTION_ID_A,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollGuildNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member → PollNotMember', () =>
    callRpc('Poll/CastVote', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
      option_id: OPTION_ID_A,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  const castVoteActionTest = (
    action: PollRpcModels.CastVoteResult['action'],
    myOptionIds: Poll.PollOptionId[],
    multiple: boolean,
  ) =>
    itEffect.effect(
      `action="${action}" → CastVoteResult has correct action, my_option_ids, and multiple`,
      () => {
        const MockPollsRepoWithAction = Layer.succeed(PollsRepository, {
          createPoll: () => Effect.die(new Error('Not used')),
          saveMessageId: () => Effect.void,
          findPollView: (pollId: Poll.PollId) =>
            Effect.succeed(Option.some(makePollView(pollId, 'open', multiple, myOptionIds))),
          castVote: (input: CastVoteCall) => {
            castVoteCalls.push(input);
            return Effect.succeed(
              new PollRpcModels.CastVoteResult({
                view: makePollView(input.pollId, 'open', multiple, myOptionIds),
                my_option_ids: myOptionIds,
                action,
              }),
            );
          },
          addOption: () => Effect.die(new Error('Not used')),
          closePoll: () => Effect.die(new Error('Not used')),
        } as any);

        const layerWithAction = PollsRpcLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              MockTeamsRepository,
              MockTeamMembersRepository,
              MockTeamSettingsRepository,
              MockPollsRepoWithAction,
            ),
          ),
        );

        return callRpc('Poll/CastVote', {
          guild_id: GUILD_ID,
          discord_user_id: MEMBER_DISCORD_ID,
          poll_id: POLL_ID,
          option_id: OPTION_ID_A,
        }).pipe(
          Effect.provide(layerWithAction),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toBeInstanceOf(PollRpcModels.CastVoteResult);
              expect(result.action).toBe(action);
              expect(result.my_option_ids).toEqual(myOptionIds);
              expect(result.view).toBeInstanceOf(PollRpcModels.PollView);
              expect(result.view.multiple).toBe(multiple);
            }),
          ),
          Effect.asVoid,
        );
      },
    );

  castVoteActionTest('counted', [OPTION_ID_A], false);
  castVoteActionTest('moved', [OPTION_ID_B], false);
  castVoteActionTest('retracted', [], false);
  castVoteActionTest('added', [OPTION_ID_A, OPTION_ID_B], true);
  castVoteActionTest('removed', [OPTION_ID_B], true);

  itEffect.effect('repo PollClosed → handler propagates PollClosed', () => {
    const MockPollsRepoWithClosed = Layer.succeed(PollsRepository, {
      createPoll: () => Effect.die(new Error('Not used')),
      saveMessageId: () => Effect.void,
      findPollView: () => Effect.succeed(Option.none()),
      castVote: () => Effect.fail(new PollRpcModels.PollClosed()),
      addOption: () => Effect.die(new Error('Not used')),
      closePoll: () => Effect.die(new Error('Not used')),
    } as any);

    const layerWithClosed = PollsRpcLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          MockTeamsRepository,
          MockTeamMembersRepository,
          MockTeamSettingsRepository,
          MockPollsRepoWithClosed,
        ),
      ),
    );

    return callRpc('Poll/CastVote', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
      option_id: OPTION_ID_A,
    }).pipe(
      Effect.provide(layerWithClosed),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollClosed');
          }
        }),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// Poll/AddOption — gate computed server-side from raw member_role_ids
// ---------------------------------------------------------------------------

describe('Poll/AddOption RPC — member_role_ids forwarded as raw array (never boolean)', () => {
  itEffect.effect('member_role_ids array forwarded exactly to repo (not a boolean)', () => {
    const RAW_ROLE_IDS = [
      '700000000000000031' as Discord.Snowflake,
      '700000000000000032' as Discord.Snowflake,
    ];

    return callRpc('Poll/AddOption', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
      label: 'New option',
      member_role_ids: RAW_ROLE_IDS,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toBeInstanceOf(PollRpcModels.AddOptionResult);
          expect(addOptionCalls).toHaveLength(1);
          // The raw array must be forwarded exactly — never transformed to a boolean
          const call = addOptionCalls[0];
          expect(call.memberRoleIds).toEqual(RAW_ROLE_IDS);
          expect(typeof call.memberRoleIds).not.toBe('boolean');
          expect(Array.isArray(call.memberRoleIds)).toBe(true);
        }),
      ),
      Effect.asVoid,
    );
  });

  itEffect.effect('empty member_role_ids array → forwarded as empty array (not false)', () =>
    callRpc('Poll/AddOption', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
      label: 'Another option',
      member_role_ids: [],
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(addOptionCalls).toHaveLength(1);
          const call = addOptionCalls[0];
          expect(call.memberRoleIds).toEqual([]);
          expect(typeof call.memberRoleIds).not.toBe('boolean');
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('repo PollAddOptionForbidden → propagated as typed error', () => {
    const MockPollsRepoForbidden = Layer.succeed(PollsRepository, {
      createPoll: () => Effect.die(new Error('Not used')),
      saveMessageId: () => Effect.void,
      findPollView: () => Effect.succeed(Option.none()),
      castVote: () => Effect.die(new Error('Not used')),
      addOption: () => Effect.fail(new PollRpcModels.PollAddOptionForbidden()),
      closePoll: () => Effect.die(new Error('Not used')),
    } as any);

    const layerForbidden = PollsRpcLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          MockTeamsRepository,
          MockTeamMembersRepository,
          MockTeamSettingsRepository,
          MockPollsRepoForbidden,
        ),
      ),
    );

    return callRpc('Poll/AddOption', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
      label: 'Forbidden option',
      member_role_ids: [ROLE_ID],
    }).pipe(
      Effect.provide(layerForbidden),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollAddOptionForbidden');
          }
        }),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// Poll/ClosePoll — permission gate + idempotent
// ---------------------------------------------------------------------------

describe('Poll/ClosePoll RPC — permission gate and idempotent close', () => {
  itEffect.effect('unknown guild_id → PollGuildNotFound', () =>
    callRpc('Poll/ClosePoll', {
      guild_id: UNKNOWN_GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      poll_id: POLL_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollGuildNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member → PollNotMember', () =>
    callRpc('Poll/ClosePoll', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('member without poll:manage → PollForbidden', () =>
    callRpc('Poll/ClosePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollForbidden');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('manager closes open poll → returns closed PollView', () =>
    callRpc('Poll/ClosePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      poll_id: POLL_ID,
    }).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          expect(view).toBeInstanceOf(PollRpcModels.PollView);
          expect(view.status).toBe('closed');
          expect(closePollCalls).toHaveLength(1);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect(
    'idempotent close — closing already-closed poll → returns closed PollView',
    () => {
      const MockPollsRepoIdempotent = Layer.succeed(PollsRepository, {
        createPoll: () => Effect.die(new Error('Not used')),
        saveMessageId: () => Effect.void,
        findPollView: (pollId: Poll.PollId) =>
          Effect.succeed(Option.some(makePollView(pollId, 'closed'))),
        castVote: () => Effect.die(new Error('Not used')),
        addOption: () => Effect.die(new Error('Not used')),
        closePoll: (input: ClosePollCall) => {
          closePollCalls.push(input);
          return Effect.succeed(makePollView(input.pollId, 'closed'));
        },
      } as any);

      const layerIdempotent = PollsRpcLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            MockTeamsRepository,
            MockTeamMembersRepository,
            MockTeamSettingsRepository,
            MockPollsRepoIdempotent,
          ),
        ),
      );

      return callRpc('Poll/ClosePoll', {
        guild_id: GUILD_ID,
        discord_user_id: MANAGER_DISCORD_ID,
        poll_id: POLL_ID,
      }).pipe(
        Effect.provide(layerIdempotent),
        Effect.tap((view) =>
          Effect.sync(() => {
            expect(view).toBeInstanceOf(PollRpcModels.PollView);
            expect(view.status).toBe('closed');
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Cross-team authorization (IDOR) — Fix A
// ---------------------------------------------------------------------------

describe('Cross-team IDOR protection', () => {
  const OTHER_TEAM_POLL_ID = '00000000-0000-0000-0000-000000000090' as Poll.PollId;

  // This mock repo returns PollNotFound when the poll_id doesn't belong to the team.
  // The handler threads teamId into castVote/closePoll, so a poll from another team → PollNotFound.
  const MockPollsRepoIdle = Layer.succeed(PollsRepository, {
    createPoll: () => Effect.die(new Error('Not used')),
    saveMessageId: () => Effect.void,
    findPollView: () => Effect.succeed(Option.none()),
    castVote: (input: CastVoteCall) => {
      // Simulate team_id guard: if poll doesn't belong to this team → PollNotFound
      if (input.pollId === OTHER_TEAM_POLL_ID) {
        return Effect.fail(new PollRpcModels.PollNotFound());
      }
      return Effect.succeed(
        new PollRpcModels.CastVoteResult({
          view: makePollView(input.pollId),
          my_option_ids: [input.optionId] as Poll.PollOptionId[],
          action: 'counted',
        }),
      );
    },
    addOption: () => Effect.die(new Error('Not used')),
    closePoll: (input: ClosePollCall) => {
      if (input.pollId === OTHER_TEAM_POLL_ID) {
        return Effect.fail(new PollRpcModels.PollNotFound());
      }
      return Effect.succeed(makePollView(input.pollId, 'closed'));
    },
  } as any);

  const layerWithIdle = PollsRpcLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        MockTeamsRepository,
        MockTeamMembersRepository,
        MockTeamSettingsRepository,
        MockPollsRepoIdle,
      ),
    ),
  );

  itEffect.effect('CastVote with poll from another team → PollNotFound', () =>
    callRpc('Poll/CastVote', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: OTHER_TEAM_POLL_ID,
      option_id: OPTION_ID_A,
    }).pipe(
      Effect.provide(layerWithIdle),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('ClosePoll with poll from another team → PollNotFound', () =>
    callRpc('Poll/ClosePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      poll_id: OTHER_TEAM_POLL_ID,
    }).pipe(
      Effect.provide(layerWithIdle),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Fix C: Invalid calendar date → PollInvalidDeadline (not a defect)
// ---------------------------------------------------------------------------

describe('Poll/CreatePoll RPC — calendar date validation', () => {
  itEffect.effect('2099-02-31 12:00 (Feb 31 does not exist) → PollInvalidDeadline', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Invalid date?',
      options_raw: 'Yes;No',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.some('2099-02-31 12:00'),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollInvalidDeadline');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('2099-04-31 12:00 (April 31 does not exist) → PollInvalidDeadline', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Invalid date?',
      options_raw: 'Yes;No',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.some('2099-04-31 12:00'),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollInvalidDeadline');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('2099-02-28 12:00 (valid Feb date) → succeeds', () =>
    callRpc('Poll/CreatePoll', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      question: 'Valid Feb date?',
      options_raw: 'Yes;No',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline_raw: Option.some('2099-02-28 12:00'),
    }).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          expect(view).toBeInstanceOf(PollRpcModels.PollView);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Fix H: Poll/GetPollView — handler routes to findPollView with team scoping
// ---------------------------------------------------------------------------

describe('Poll/GetPollView RPC', () => {
  itEffect.effect('known guild + member + existing poll → returns Option.some(PollView)', () =>
    callRpc('Poll/GetPollView', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isSome(result)).toBe(true);
          if (Option.isSome(result)) {
            expect(result.value).toBeInstanceOf(PollRpcModels.PollView);
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('unknown guild → PollGuildNotFound', () =>
    callRpc('Poll/GetPollView', {
      guild_id: UNKNOWN_GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollGuildNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member → PollNotMember', () =>
    callRpc('Poll/GetPollView', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      poll_id: POLL_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('PollNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-existent poll → Option.none()', () => {
    const NON_EXISTENT_POLL_ID = '00000000-0000-0000-0000-ffffffffffff' as Poll.PollId;
    return callRpc('Poll/GetPollView', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      poll_id: NON_EXISTENT_POLL_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isNone(result)).toBe(true);
        }),
      ),
      Effect.asVoid,
    );
  });
});
