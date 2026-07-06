// TDD mode — written BEFORE the implementation changes land.
// Tests will fail to import until poll.ts interactions are updated.
// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// vi.mock is hoisted before imports by Vitest. The factory mocks ~/env.js so
// that @t3-oss/env-core does not throw during module load.

import type { Discord } from '@sideline/domain';
import { type Poll, PollRpcModels } from '@sideline/domain';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  PollAddButton,
  PollAddModalSubmit,
  PollCloseButton,
  PollOpenButton,
  PollRemoveButton,
  PollRemoveSelectSubmit,
  PollVoteButton,
  PollVotersButton,
} from '~/interactions/poll.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// env mock — required because @t3-oss/env-core snapshots at module load
// ---------------------------------------------------------------------------

vi.mock('~/env.js', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target: Record<string, unknown>, prop: string) => {
      if (prop === 'NODE_ENV') return 'test';
      if (prop === 'SERVER_URL') return 'http://localhost:3000';
      if (prop === 'APP_ENV') return 'test';
      if (prop === 'APP_ORIGIN') return 'localhost';
      if (prop === 'OTEL_EXPORTER_OTLP_ENDPOINT') return 'http://localhost:4318';
      if (prop === 'OTEL_SERVICE_NAME') return 'sideline-bot';
      if (prop === 'WEB_URL') return Option.none();
      return undefined;
    },
  }),
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '900000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '900000000000000010' as DiscordTypes.Snowflake;
const MESSAGE_ID = '900000000000000011' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '900000000000000030' as DiscordTypes.Snowflake;
const APP_ID = '900000000000000040' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-poll-token';

const POLL_ID = 'poll-interact-001' as Poll.PollId;
const OPTION_ID_A = 'opt-interact-a' as Poll.PollOptionId;
const OPTION_ID_B = 'opt-interact-b' as Poll.PollOptionId;
const ROLE_ID_1 = '900000000000000050' as Discord.Snowflake;
const ROLE_ID_2 = '900000000000000051' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePollOptionView = (
  optionId: string,
  label: string,
  position: number,
  voteCount = 0,
): PollRpcModels.PollOptionView =>
  new PollRpcModels.PollOptionView({
    option_id: optionId as Poll.PollOptionId,
    label,
    position,
    vote_count: voteCount,
  });

const makePollView = (
  status: Poll.PollStatus = 'open',
  myOptionIds: Poll.PollOptionId[] = [],
): PollRpcModels.PollView =>
  new PollRpcModels.PollView({
    poll_id: POLL_ID,
    discord_channel_id: CHANNEL_ID as Discord.Snowflake,
    discord_message_id: Option.some(MESSAGE_ID as Discord.Snowflake),
    question: 'Test poll?',
    status,
    multiple: false,
    allowed_role_id: Option.none(),
    deadline: Option.none(),
    total_votes: myOptionIds.length,
    options: [
      makePollOptionView(OPTION_ID_A, 'Option A', 0),
      makePollOptionView(OPTION_ID_B, 'Option B', 1),
    ],
    my_option_ids: myOptionIds,
  });

const makeCastVoteResult = (
  action: PollRpcModels.CastVoteResult['action'] = 'counted',
  myOptionIds: Poll.PollOptionId[] = [OPTION_ID_A],
): PollRpcModels.CastVoteResult =>
  new PollRpcModels.CastVoteResult({
    view: makePollView('open', myOptionIds),
    my_option_ids: myOptionIds,
    action,
  });

const makeAddOptionResult = (): PollRpcModels.AddOptionResult =>
  new PollRpcModels.AddOptionResult({
    option_id: OPTION_ID_A,
    view: makePollView(),
  });

const makePollVotersView = (): PollRpcModels.PollVotersView =>
  new PollRpcModels.PollVotersView({
    poll_id: POLL_ID,
    question: 'Test poll?',
    status: 'open',
    total_votes: 1,
    options: [
      new PollRpcModels.PollOptionVoters({
        option_id: OPTION_ID_A,
        label: 'Option A',
        position: 0,
        vote_count: 1,
        voters: [
          new PollRpcModels.PollVoter({
            discord_id: Option.some(USER_DISCORD_ID as Discord.Snowflake),
            name: Option.some('Test User'),
            nickname: Option.none(),
            display_name: Option.none(),
            username: Option.some('testuser'),
          }),
        ],
      }),
      new PollRpcModels.PollOptionVoters({
        option_id: OPTION_ID_B,
        label: 'Option B',
        position: 1,
        vote_count: 0,
        voters: [],
      }),
    ],
  });

// ---------------------------------------------------------------------------
// DiscordREST stub
// ---------------------------------------------------------------------------

interface RestStubOptions {
  updateMessage?: ReturnType<typeof vi.fn>;
  createInteractionResponse?: ReturnType<typeof vi.fn>;
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const updateMessage = options.updateMessage ?? vi.fn(() => Effect.succeed(undefined));
  const createInteractionResponse =
    options.createInteractionResponse ?? vi.fn(() => Effect.succeed(undefined));
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateMessage') return updateMessage;
      if (prop === 'createInteractionResponse') return createInteractionResponse;
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, updateMessage, createInteractionResponse, updateOriginalWebhookMessage };
};

// ---------------------------------------------------------------------------
// SyncRpc stub
// ---------------------------------------------------------------------------

interface SyncRpcStubOptions {
  'Poll/CastVote'?: ReturnType<typeof vi.fn>;
  'Poll/AddOption'?: ReturnType<typeof vi.fn>;
  'Poll/ClosePoll'?: ReturnType<typeof vi.fn>;
  'Poll/GetPollView'?: ReturnType<typeof vi.fn>;
  'Poll/GetPollVoters'?: ReturnType<typeof vi.fn>;
  'Poll/RemoveOptions'?: ReturnType<typeof vi.fn>;
}

const makeSyncRpcStub = (options: SyncRpcStubOptions = {}) => {
  const rpcStub = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (options[prop as keyof SyncRpcStubOptions]) {
        return options[prop as keyof SyncRpcStubOptions];
      }
      if (prop === 'Poll/CastVote') {
        return vi.fn(() => Effect.succeed(makeCastVoteResult()));
      }
      if (prop === 'Poll/AddOption') {
        return vi.fn(() => Effect.succeed(makeAddOptionResult()));
      }
      if (prop === 'Poll/ClosePoll') {
        return vi.fn(() => Effect.succeed(makePollView('closed')));
      }
      if (prop === 'Poll/GetPollView') {
        return vi.fn(() => Effect.succeed(Option.some(makePollView('closed'))));
      }
      if (prop === 'Poll/GetPollVoters') {
        return vi.fn(() => Effect.succeed(Option.some(makePollVotersView())));
      }
      if (prop === 'Poll/RemoveOptions') {
        return vi.fn(() => Effect.succeed(makePollView()));
      }
      return vi.fn(() => Effect.succeed(undefined));
    },
  });

  const layer = Layer.succeed(SyncRpc, rpcStub);
  return { layer, rpcStub };
};

// ---------------------------------------------------------------------------
// Interaction fixture builders
// ---------------------------------------------------------------------------

const makeComponentInteraction = (
  customId: string,
  userId: string = USER_DISCORD_ID,
  channelId: string = CHANNEL_ID,
  messageId: string = MESSAGE_ID,
  memberRoles: string[] = [ROLE_ID_1, ROLE_ID_2],
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: GUILD_ID,
    channel_id: channelId as DiscordTypes.Snowflake,
    channel: {
      id: channelId as DiscordTypes.Snowflake,
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: userId as DiscordTypes.Snowflake,
        username: 'testuser',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: memberRoles,
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '8',
    },
    locale: 'en-US',
    data: {
      component_type: 2,
      custom_id: customId,
    },
    message: {
      id: messageId as DiscordTypes.Snowflake,
      channel_id: channelId as DiscordTypes.Snowflake,
    },
  }) as unknown as DiscordTypes.APIInteraction;

const makeModalInteraction = (
  customId: string,
  labelValue: string,
  userId: string = USER_DISCORD_ID,
  channelId: string = CHANNEL_ID,
  _messageId: string = MESSAGE_ID,
  memberRoles: string[] = [ROLE_ID_1, ROLE_ID_2],
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567891' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MODAL_SUBMIT,
    guild_id: GUILD_ID,
    channel_id: channelId as DiscordTypes.Snowflake,
    channel: {
      id: channelId as DiscordTypes.Snowflake,
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: userId as DiscordTypes.Snowflake,
        username: 'testuser',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: memberRoles,
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '8',
    },
    locale: 'en-US',
    data: {
      custom_id: customId,
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'poll-option-label',
              value: labelValue,
            },
          ],
        },
      ],
    },
  }) as unknown as DiscordTypes.APIInteraction;

// ---------------------------------------------------------------------------
// Helper to run a handler
// ---------------------------------------------------------------------------

const runHandler = async (
  handler: Effect.Effect<unknown, unknown, unknown>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    handler.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  // Allow microtask queue to flush so forkDetach tasks complete
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Tests — poll-vote button (now on ephemeral private view)
// ---------------------------------------------------------------------------

describe('poll-vote button interaction', () => {
  it('parses pollId and optionId from custom_id and calls Poll/CastVote', async () => {
    const castVoteFn = vi.fn(() => Effect.succeed(makeCastVoteResult('counted', [OPTION_ID_A])));
    const rpcStub = makeSyncRpcStub({ 'Poll/CastVote': castVoteFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(castVoteFn).toHaveBeenCalledWith(
      expect.objectContaining({
        poll_id: POLL_ID,
        option_id: OPTION_ID_A,
      }),
    );
  });

  it('custom_id parsing extracts correct pollId and optionId (different ids)', async () => {
    const specificPollId = 'specific-poll-abc' as Poll.PollId;
    const specificOptionId = 'specific-opt-xyz' as Poll.PollOptionId;
    const castVoteFn = vi.fn(() =>
      Effect.succeed(
        new PollRpcModels.CastVoteResult({
          view: new PollRpcModels.PollView({
            poll_id: specificPollId,
            discord_channel_id: CHANNEL_ID as Discord.Snowflake,
            discord_message_id: Option.some(MESSAGE_ID as Discord.Snowflake),
            question: 'Q?',
            status: 'open',
            multiple: false,
            allowed_role_id: Option.none(),
            deadline: Option.none(),
            total_votes: 1,
            options: [],
            my_option_ids: [specificOptionId],
          }),
          my_option_ids: [specificOptionId],
          action: 'counted',
        }),
      ),
    );
    const rpcStub = makeSyncRpcStub({ 'Poll/CastVote': castVoteFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${specificPollId}:${specificOptionId}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(castVoteFn).toHaveBeenCalledWith(
      expect.objectContaining({
        poll_id: specificPollId,
        option_id: specificOptionId,
      }),
    );
  });

  // NEW: vote button now responds with DEFERRED_UPDATE_MESSAGE (type 6) not ephemeral deferred
  it('vote button returns DEFERRED_UPDATE_MESSAGE (type 6) — edits ephemeral in-place', async () => {
    const rpcStub = makeSyncRpcStub();
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    const response = await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    const responseJson = JSON.stringify(response);
    // DEFERRED_UPDATE_MESSAGE = type 6
    expect(responseJson).toContain(
      String(DiscordTypes.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE),
    );
  });

  // NEW: on success, updateOriginalWebhookMessage called with embeds+components (re-rendered private view)
  it('CastVote action=counted → updateOriginalWebhookMessage called with embeds and components (private view refresh)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('counted', [OPTION_ID_A]))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const callArgs = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payloadStr = JSON.stringify(callArgs);
    // The private-view re-render must include embeds and components
    expect(payloadStr).toContain('embeds');
    expect(payloadStr).toContain('components');
  });

  // NEW: on success, updateMessage also called with public board (allowed_mentions: { parse: [] })
  it('CastVote action=counted → updateMessage (public board) called with allowed_mentions: { parse: [] }', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('counted', [OPTION_ID_A]))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });

  it('CastVote action=moved → updateOriginalWebhookMessage called (private view updated)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('moved', [OPTION_ID_B]))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('CastVote action=retracted → updateOriginalWebhookMessage called', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('retracted', []))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('CastVote action=added (multi) → updateOriginalWebhookMessage called', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() =>
        Effect.succeed(makeCastVoteResult('added', [OPTION_ID_A, OPTION_ID_B])),
      ),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('CastVote action=removed (multi) → updateOriginalWebhookMessage called', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('removed', [OPTION_ID_B]))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('RpcClientError from CastVote → resolves deferred reply with generic error (no forever-loading spinner)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.fail({ _tag: 'RpcClientError' } as never)),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    // The deferred ephemeral must be resolved (spinner cleared) rather than left hanging.
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  // NEW: PollClosed → ephemeral edit passes components: [] (cleared) + board rebuilt
  it('PollClosed from CastVote → ephemeral edit passes components: [] (clears stale toggle buttons)', async () => {
    const closedView = makePollView('closed');
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(closedView)));
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.fail(new PollRpcModels.PollClosed())),
      'Poll/GetPollView': getPollViewFn,
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    // The ephemeral edit on PollClosed must pass components: [] to clear stale toggle buttons
    const callArgs = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payloadStr = JSON.stringify(callArgs);
    expect(payloadStr).toContain('"components":[]');
  });

  it('PollClosed from CastVote → Poll/GetPollView called and board rebuilt with closed state', async () => {
    const closedView = makePollView('closed');
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(closedView)));
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.fail(new PollRpcModels.PollClosed())),
      'Poll/GetPollView': getPollViewFn,
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    // GetPollView must be called to fetch the current closed state
    expect(getPollViewFn).toHaveBeenCalled();
    // Board must be rebuilt (updateMessage called) so closed buttons are shown
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
    // Ephemeral closed notice sent
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('PollClosed from AddOption → Poll/GetPollView called and board rebuilt', async () => {
    const closedView = makePollView('closed');
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(closedView)));
    const rpcStub = makeSyncRpcStub({
      'Poll/AddOption': vi.fn(() => Effect.fail(new PollRpcModels.PollClosed())),
      'Poll/GetPollView': getPollViewFn,
    });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'A New Option',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      [ROLE_ID_1],
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    // GetPollView must be called
    expect(getPollViewFn).toHaveBeenCalled();
    // Board rebuilt at the stored channel/message ids
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
    // Ephemeral closed notice sent
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('missing user id in interaction → ephemeral reply, no RPC called', async () => {
    const castVoteFn = vi.fn(() => Effect.succeed(makeCastVoteResult()));
    const rpcStub = makeSyncRpcStub({ 'Poll/CastVote': castVoteFn });
    const restStub = makeRestStub();

    const noUserInteraction: DiscordTypes.APIInteraction = {
      id: '1234567890' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      // No member field
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-vote:${POLL_ID}:${OPTION_ID_A}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, noUserInteraction);

    // RPC must NOT be called when user id is missing
    expect(castVoteFn).not.toHaveBeenCalled();
    // An ephemeral error response should still be sent
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  // UPDATED: vote button on ephemeral no longer returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE+Ephemeral
  // it now returns DEFERRED_UPDATE_MESSAGE (type 6) to edit the ephemeral in place
  it('undefined guild_id → ephemeral error reply, no CastVote called', async () => {
    const castVoteFn = vi.fn(() => Effect.succeed(makeCastVoteResult()));
    const rpcStub = makeSyncRpcStub({ 'Poll/CastVote': castVoteFn });
    const restStub = makeRestStub();

    const noGuildInteraction: DiscordTypes.APIInteraction = {
      id: '1234567890' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      // guild_id explicitly absent
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      member: {
        user: {
          id: USER_DISCORD_ID,
          username: 'testuser',
          discriminator: '0001',
          global_name: null,
          avatar: null,
        },
        roles: [],
        joined_at: '2024-01-01T00:00:00Z',
        deaf: false,
        mute: false,
        permissions: '8',
      },
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-vote:${POLL_ID}:${OPTION_ID_A}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, noGuildInteraction);

    expect(castVoteFn).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — poll-open button (new: opens per-user ephemeral private view)
// ---------------------------------------------------------------------------

describe('PollOpenButton — poll-open:{pollId}', () => {
  it('returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE + Ephemeral (fresh per-user ephemeral)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(makePollView('open')))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-open:${POLL_ID}`);
    const response = await runHandler(PollOpenButton, restStub.layer, rpcStub.layer, interaction);

    const r = response as any;
    expect(r.type).toBe(DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
    expect(r.data?.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });

  it('calls Poll/GetPollView with {poll_id, discord_user_id, guild_id}', async () => {
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(makePollView('open'))));
    const rpcStub = makeSyncRpcStub({ 'Poll/GetPollView': getPollViewFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-open:${POLL_ID}`);
    await runHandler(PollOpenButton, restStub.layer, rpcStub.layer, interaction);

    expect(getPollViewFn).toHaveBeenCalledWith(
      expect.objectContaining({
        poll_id: POLL_ID,
        discord_user_id: USER_DISCORD_ID,
        guild_id: GUILD_ID,
      }),
    );
  });

  it('Option.some(view) → updateOriginalWebhookMessage called with poll-vote: component(s)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(makePollView('open')))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-open:${POLL_ID}`);
    await runHandler(PollOpenButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const callArgs = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payloadStr = JSON.stringify(callArgs);
    // The private view must contain poll-vote: buttons
    expect(payloadStr).toContain('poll-vote:');
  });

  it('Option.some(view) → updateOriginalWebhookMessage payload has allowed_mentions: { parse: [] }', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(makePollView('open')))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-open:${POLL_ID}`);
    await runHandler(PollOpenButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const callArgs = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payloadStr = JSON.stringify(callArgs);
    expect(payloadStr).toContain('"allowed_mentions":{"parse":[]}');
  });

  it('Option.none → updateOriginalWebhookMessage called with not-found content, no crash', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.none())),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-open:${POLL_ID}`);
    await expect(
      runHandler(PollOpenButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    // Spinner must be resolved even on Option.none — not-found ephemeral
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('RpcClientError from GetPollView → resolves with generic error (no forever-loading spinner)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.fail({ _tag: 'RpcClientError' } as never)),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-open:${POLL_ID}`);
    await expect(
      runHandler(PollOpenButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('missing user id → ephemeral error, GetPollView NOT called', async () => {
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(makePollView('open'))));
    const rpcStub = makeSyncRpcStub({ 'Poll/GetPollView': getPollViewFn });
    const restStub = makeRestStub();

    const noUserInteraction: DiscordTypes.APIInteraction = {
      id: '1234567890' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      // No member field — user id is unknown
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-open:${POLL_ID}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollOpenButton, restStub.layer, rpcStub.layer, noUserInteraction);

    // GetPollView must NOT be called when user id is absent
    expect(getPollViewFn).not.toHaveBeenCalled();
    // An ephemeral error must still be sent to resolve the spinner
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('undefined guild_id → ephemeral error, GetPollView NOT called', async () => {
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(makePollView('open'))));
    const rpcStub = makeSyncRpcStub({ 'Poll/GetPollView': getPollViewFn });
    const restStub = makeRestStub();

    const noGuildInteraction: DiscordTypes.APIInteraction = {
      id: '1234567890' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      // guild_id explicitly absent
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      member: {
        user: {
          id: USER_DISCORD_ID,
          username: 'testuser',
          discriminator: '0001',
          global_name: null,
          avatar: null,
        },
        roles: [],
        joined_at: '2024-01-01T00:00:00Z',
        deaf: false,
        mute: false,
        permissions: '8',
      },
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-open:${POLL_ID}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollOpenButton, restStub.layer, rpcStub.layer, noGuildInteraction);

    expect(getPollViewFn).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — poll-add button (returns modal)
// ---------------------------------------------------------------------------

describe('poll-add button interaction', () => {
  it('add button returns a MODAL response with max_length 80 input', async () => {
    const rpcStub = makeSyncRpcStub();
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-add:${POLL_ID}`);
    const response = await runHandler(PollAddButton, restStub.layer, rpcStub.layer, interaction);

    const responseJson = JSON.stringify(response);
    // Must be a MODAL response (type 9)
    expect(responseJson).toContain(String(DiscordTypes.InteractionCallbackTypes.MODAL));
    // Must include max_length: 80 for the label input
    expect(responseJson).toContain('80');
  });

  it('add button modal custom_id format: poll-add-modal:{channel}:{message}:{pollId}', async () => {
    const rpcStub = makeSyncRpcStub();
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(
      `poll-add:${POLL_ID}`,
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
    );
    const response = await runHandler(PollAddButton, restStub.layer, rpcStub.layer, interaction);

    const responseJson = JSON.stringify(response);
    const expectedModalId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    expect(responseJson).toContain(expectedModalId);
  });

  it('add button does NOT call Poll/AddOption (modal is returned, no pre-gate)', async () => {
    const addOptionFn = vi.fn(() => Effect.succeed(makeAddOptionResult()));
    const rpcStub = makeSyncRpcStub({ 'Poll/AddOption': addOptionFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-add:${POLL_ID}`);
    await runHandler(PollAddButton, restStub.layer, rpcStub.layer, interaction);

    expect(addOptionFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — poll-add modal submit (CRITICAL: member_role_ids from raw roles array)
// ---------------------------------------------------------------------------

describe('poll-add modal submit interaction', () => {
  it('reads interaction.member.roles as raw array and forwards as member_role_ids (not a boolean)', async () => {
    const EXACT_ROLE_IDS = [ROLE_ID_1, ROLE_ID_2];
    const addOptionFn = vi.fn(() => Effect.succeed(makeAddOptionResult()));
    const rpcStub = makeSyncRpcStub({ 'Poll/AddOption': addOptionFn });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'My New Option',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      EXACT_ROLE_IDS,
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(addOptionFn).toHaveBeenCalledWith(
      expect.objectContaining({
        poll_id: POLL_ID,
        label: 'My New Option',
        member_role_ids: EXACT_ROLE_IDS,
      }),
    );
    const callArgs = (addOptionFn.mock.calls as unknown[][])[0]?.[0] as
      | { member_role_ids: unknown }
      | undefined;
    expect(callArgs).toBeDefined();
    expect(Array.isArray(callArgs?.member_role_ids)).toBe(true);
    expect(typeof callArgs?.member_role_ids).not.toBe('boolean');
  });

  it('member with no roles → member_role_ids=[] (empty array, not false)', async () => {
    const addOptionFn = vi.fn(() => Effect.succeed(makeAddOptionResult()));
    const rpcStub = makeSyncRpcStub({ 'Poll/AddOption': addOptionFn });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'Option With No Roles',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      [], // empty roles
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(addOptionFn).toHaveBeenCalledWith(
      expect.objectContaining({
        member_role_ids: [],
      }),
    );
    const callArgs = (addOptionFn.mock.calls as unknown[][])[0]?.[0] as
      | { member_role_ids: unknown }
      | undefined;
    expect(callArgs).toBeDefined();
    expect(callArgs?.member_role_ids).toEqual([]);
    expect(typeof callArgs?.member_role_ids).not.toBe('boolean');
  });

  it('AddOptionForbidden → ephemeral error response', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/AddOption': vi.fn(() => Effect.fail(new PollRpcModels.PollAddOptionForbidden())),
    });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'Forbidden Option',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      [],
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(payload.length).toBeGreaterThan(0);
  });

  it('PollOptionLimitReached → ephemeral error response', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/AddOption': vi.fn(() => Effect.fail(new PollRpcModels.PollOptionLimitReached())),
    });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'EleventhOption',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      [ROLE_ID_1],
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('PollDuplicateOption → ephemeral error response', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/AddOption': vi.fn(() => Effect.fail(new PollRpcModels.PollDuplicateOption())),
    });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'Duplicate',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      [ROLE_ID_1],
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('PollClosed from AddOption → ephemeral error response', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/AddOption': vi.fn(() => Effect.fail(new PollRpcModels.PollClosed())),
    });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'Option To Closed Poll',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      [ROLE_ID_1],
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('successful add → board rebuilt (updateMessage called on stored channel/message id)', async () => {
    const addOptionFn = vi.fn(() => Effect.succeed(makeAddOptionResult()));
    const rpcStub = makeSyncRpcStub({ 'Poll/AddOption': addOptionFn });
    const restStub = makeRestStub();

    const modalCustomId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    const interaction = makeModalInteraction(
      modalCustomId,
      'New Valid Option',
      USER_DISCORD_ID,
      CHANNEL_ID,
      MESSAGE_ID,
      [ROLE_ID_1],
    );

    await runHandler(PollAddModalSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(addOptionFn).toHaveBeenCalled();
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — poll-close button
// ---------------------------------------------------------------------------

describe('poll-close button interaction', () => {
  it('calls Poll/ClosePoll with correct poll_id parsed from custom_id', async () => {
    const closePollFn = vi.fn(() => Effect.succeed(makePollView('closed')));
    const rpcStub = makeSyncRpcStub({ 'Poll/ClosePoll': closePollFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-close:${POLL_ID}`);
    await runHandler(PollCloseButton, restStub.layer, rpcStub.layer, interaction);

    expect(closePollFn).toHaveBeenCalledWith(expect.objectContaining({ poll_id: POLL_ID }));
  });

  it('close button rebuilds board with closed view after success', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/ClosePoll': vi.fn(() => Effect.succeed(makePollView('closed'))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-close:${POLL_ID}`);
    await runHandler(PollCloseButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });

  it('PollForbidden from ClosePoll → ephemeral error (not captain)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/ClosePoll': vi.fn(() => Effect.fail(new PollRpcModels.PollForbidden())),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-close:${POLL_ID}`);
    await runHandler(PollCloseButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(payload.length).toBeGreaterThan(0);
  });

  it('missing user id for close → ephemeral reply, no RPC called', async () => {
    const closePollFn = vi.fn(() => Effect.succeed(makePollView('closed')));
    const rpcStub = makeSyncRpcStub({ 'Poll/ClosePoll': closePollFn });
    const restStub = makeRestStub();

    const noUserInteraction: DiscordTypes.APIInteraction = {
      id: '1234567892' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      // No member
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-close:${POLL_ID}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollCloseButton, restStub.layer, rpcStub.layer, noUserInteraction);

    expect(closePollFn).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — PollVotersButton (TDD mode — handler does not exist yet)
// custom_id: poll-voters:{pollId}
// Returns immediate ephemeral DEFERRED, forks RPC Poll/GetPollVoters,
// replies via webhook. NEVER updates the shared board message.
// ---------------------------------------------------------------------------

describe('PollVotersButton — poll-voters:{pollId}', () => {
  it('returns immediate DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE + Ephemeral response', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollVoters': vi.fn(() => Effect.succeed(Option.some(makePollVotersView()))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-voters:${POLL_ID}`);
    const response = await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, interaction);

    const r = response as any;
    expect(r.type).toBe(DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
    expect(r.data?.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });

  it('success → webhook reply carries allowed_mentions: { parse: [] } and the voters embed', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollVoters': vi.fn(() => Effect.succeed(Option.some(makePollVotersView()))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-voters:${POLL_ID}`);
    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(payload).toContain('"parse":[]');
    expect(payload).toContain('embeds');
  });

  it('RpcClientError → resolves with bot_poll_err_generic (no forever-loading spinner)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollVoters': vi.fn(() => Effect.fail({ _tag: 'RpcClientError' } as never)),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-voters:${POLL_ID}`);
    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, interaction);

    // Deferred spinner must be resolved with an error, not left hanging forever
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "Something went wrong. Please try again."
    expect(payload).toContain('Something went wrong. Please try again.');
  });

  it('Option.None → bot_poll_err_not_found', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollVoters': vi.fn(() => Effect.succeed(Option.none())),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-voters:${POLL_ID}`);
    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "This poll no longer exists."
    expect(payload).toContain('This poll no longer exists.');
  });

  it('PollGuildNotFound → err_no_guild', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollVoters': vi.fn(() => Effect.fail(new PollRpcModels.PollGuildNotFound())),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-voters:${POLL_ID}`);
    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "This command can only be used on a Discord server."
    expect(payload).toContain('This command can only be used on a Discord server.');
  });

  it('PollNotMember → err_not_member', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollVoters': vi.fn(() => Effect.fail(new PollRpcModels.PollNotMember())),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-voters:${POLL_ID}`);
    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "You are not a member of this team."
    expect(payload).toContain('You are not a member of this team.');
  });

  it('DM / no guild_id → err_no_guild without calling GetPollVoters', async () => {
    const getVotersFn = vi.fn(() => Effect.succeed(Option.some(makePollVotersView())));
    const rpcStub = makeSyncRpcStub({ 'Poll/GetPollVoters': getVotersFn });
    const restStub = makeRestStub();

    const noGuildInteraction: DiscordTypes.APIInteraction = {
      id: '1234567890' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      // guild_id explicitly absent (DM context).
      // The handler reads guild_id FIRST and short-circuits with err_no_guild
      // before it ever inspects member.user.id — so `member` being present here
      // does NOT trigger the member-missing branch; the guild check fires first.
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      member: {
        user: {
          id: USER_DISCORD_ID,
          username: 'testuser',
          discriminator: '0001',
          global_name: null,
          avatar: null,
        },
        roles: [],
        joined_at: '2024-01-01T00:00:00Z',
        deaf: false,
        mute: false,
        permissions: '8',
      },
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-voters:${POLL_ID}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, noGuildInteraction);

    expect(getVotersFn).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('no user id → err_not_member without calling GetPollVoters', async () => {
    const getVotersFn = vi.fn(() => Effect.succeed(Option.some(makePollVotersView())));
    const rpcStub = makeSyncRpcStub({ 'Poll/GetPollVoters': getVotersFn });
    const restStub = makeRestStub();

    const noUserInteraction: DiscordTypes.APIInteraction = {
      id: '1234567893' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      // No member field
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-voters:${POLL_ID}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, noUserInteraction);

    expect(getVotersFn).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('handler NEVER calls updateMessage (no shared board update — ephemeral only)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollVoters': vi.fn(() => Effect.succeed(Option.some(makePollVotersView()))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-voters:${POLL_ID}`);
    await runHandler(PollVotersButton, restStub.layer, rpcStub.layer, interaction);

    // The voters view is ephemeral-only — must NEVER touch the shared board message
    expect(restStub.updateMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Helper: string-select interaction (component_type 3) with data.values
// ---------------------------------------------------------------------------

const makeSelectInteraction = (
  customId: string,
  selectedValues: string[],
  userId: string = USER_DISCORD_ID,
  channelId: string = CHANNEL_ID,
  messageId: string = MESSAGE_ID,
  memberRoles: string[] = [ROLE_ID_1, ROLE_ID_2],
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567894' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: GUILD_ID,
    channel_id: channelId as DiscordTypes.Snowflake,
    channel: {
      id: channelId as DiscordTypes.Snowflake,
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: userId as DiscordTypes.Snowflake,
        username: 'testuser',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: memberRoles,
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '8',
    },
    locale: 'en-US',
    data: {
      component_type: 3, // STRING_SELECT
      custom_id: customId,
      values: selectedValues,
    },
    message: {
      id: messageId as DiscordTypes.Snowflake,
      channel_id: channelId as DiscordTypes.Snowflake,
    },
  }) as unknown as DiscordTypes.APIInteraction;

// Helper: poll view with 3 options (enough to select from for remove)
const makePollViewWith3Options = (status: Poll.PollStatus = 'open'): PollRpcModels.PollView => {
  const OPTION_ID_C = 'opt-interact-c' as Poll.PollOptionId;
  return new PollRpcModels.PollView({
    poll_id: POLL_ID,
    discord_channel_id: CHANNEL_ID as Discord.Snowflake,
    discord_message_id: Option.some(MESSAGE_ID as Discord.Snowflake),
    question: 'Test poll with 3 options?',
    status,
    multiple: false,
    allowed_role_id: Option.none(),
    deadline: Option.none(),
    total_votes: 0,
    options: [
      new PollRpcModels.PollOptionView({
        option_id: OPTION_ID_A,
        label: 'Option A',
        position: 0,
        vote_count: 0,
      }),
      new PollRpcModels.PollOptionView({
        option_id: OPTION_ID_B,
        label: 'Option B',
        position: 1,
        vote_count: 0,
      }),
      new PollRpcModels.PollOptionView({
        option_id: OPTION_ID_C,
        label: 'Option C',
        position: 2,
        vote_count: 0,
      }),
    ],
    my_option_ids: [],
  });
};

// ---------------------------------------------------------------------------
// Tests — PollRemoveButton (TDD mode — handler does not exist yet)
// custom_id: poll-remove:{pollId}
// Opens an ephemeral string select with max_values = options.length - 2,
// so at least 2 options always remain.
// ---------------------------------------------------------------------------

describe('PollRemoveButton — poll-remove:{pollId}', () => {
  it('opens ephemeral with a string-select whose custom_id starts with poll-remove-select:', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(makePollViewWith3Options()))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-remove:${POLL_ID}`);
    const response = await runHandler(PollRemoveButton, restStub.layer, rpcStub.layer, interaction);

    const responseJson = JSON.stringify(response);
    expect(responseJson).toContain('poll-remove-select:');
  });

  it('string-select has max_values === 1 for 3-option poll (3-2=1) and min_values===1', async () => {
    // 3 options → max_values = 1 (3 - 2 = 1); min_values must also be 1
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(makePollViewWith3Options()))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-remove:${POLL_ID}`);
    const response = await runHandler(PollRemoveButton, restStub.layer, rpcStub.layer, interaction);

    // Parse the response and find the string-select component — no brittle substring scan.
    const responseData = (response as any)?.data ?? response;
    const allComponents = JSON.parse(JSON.stringify(responseData)) as Record<string, unknown>;
    const allComponentsStr = JSON.stringify(allComponents);
    // Navigate to the select component (type 3 = STRING_SELECT) and check numeric fields
    const parsed = JSON.parse(allComponentsStr) as {
      components?: Array<{
        components?: Array<{ type?: number; max_values?: number; min_values?: number }>;
      }>;
    };
    const rows = parsed?.components ?? [];
    const selects = rows.flatMap((r) => r?.components ?? []).filter((c) => c?.type === 3);
    expect(selects).toHaveLength(1);
    expect(selects[0]?.max_values).toBe(1);
    expect(selects[0]?.min_values).toBe(1);
  });

  it('string-select has max_values === 3 for 5-option poll (5-2=3)', async () => {
    // 5-option poll → max_values = 5 - 2 = 3
    const OPTION_ID_D = 'opt-interact-d' as Poll.PollOptionId;
    const OPTION_ID_E = 'opt-interact-e' as Poll.PollOptionId;
    const fiveOptionView = new PollRpcModels.PollView({
      poll_id: POLL_ID,
      discord_channel_id: CHANNEL_ID as Discord.Snowflake,
      discord_message_id: Option.some(MESSAGE_ID as Discord.Snowflake),
      question: '5-option poll?',
      status: 'open',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline: Option.none(),
      total_votes: 0,
      options: [
        makePollOptionView(OPTION_ID_A, 'A', 0),
        makePollOptionView(OPTION_ID_B, 'B', 1),
        makePollOptionView('opt-interact-c' as Poll.PollOptionId, 'C', 2),
        makePollOptionView(OPTION_ID_D, 'D', 3),
        makePollOptionView(OPTION_ID_E, 'E', 4),
      ],
      my_option_ids: [],
    });
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(fiveOptionView))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-remove:${POLL_ID}`);
    const response = await runHandler(PollRemoveButton, restStub.layer, rpcStub.layer, interaction);

    const allComponentsStr = JSON.stringify(response);
    const parsed = JSON.parse(allComponentsStr) as {
      data?: {
        components?: Array<{
          components?: Array<{ type?: number; max_values?: number }>;
        }>;
      };
    };
    const rows = parsed?.data?.components ?? [];
    const selects = rows.flatMap((r) => r?.components ?? []).filter((c) => c?.type === 3);
    expect(selects).toHaveLength(1);
    expect(selects[0]?.max_values).toBe(3);
  });

  it('select options map each poll option to a select choice', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(makePollViewWith3Options()))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-remove:${POLL_ID}`);
    const response = await runHandler(PollRemoveButton, restStub.layer, rpcStub.layer, interaction);

    const responseJson = JSON.stringify(response);
    // All 3 options must appear as select choices (their labels)
    expect(responseJson).toContain('Option A');
    expect(responseJson).toContain('Option B');
    expect(responseJson).toContain('Option C');
  });

  it('poll with only 2 options → replies with min-options error; no select opened', async () => {
    // A 2-option poll: removing any one would leave only 1 — not allowed.
    // The handler must respond with an immediate ephemeral error (not a deferred spinner).
    const rpcStub = makeSyncRpcStub({
      'Poll/GetPollView': vi.fn(() => Effect.succeed(Option.some(makePollView('open')))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-remove:${POLL_ID}`);
    const response = await runHandler(PollRemoveButton, restStub.layer, rpcStub.layer, interaction);

    const responseJson = JSON.stringify(response);
    // Must NOT include a string-select (no removal possible from 2-option poll)
    expect(responseJson).not.toContain('poll-remove-select:');
    // The response must be a non-empty immediate ephemeral reply — a no-op handler
    // (returning undefined / empty) would not pass this assertion.
    expect(responseJson.length).toBeGreaterThan(10);
    // It must carry the Ephemeral flag (64) in its data.flags to confirm it's ephemeral
    const parsed = JSON.parse(responseJson) as { data?: { flags?: number; content?: string } };
    const flags = parsed?.data?.flags ?? 0;
    expect(flags & 64).toBe(64); // MessageFlags.Ephemeral = 64
    // Confirm no deferred webhook was called (error is immediate, not deferred+resolved)
    expect(restStub.updateOriginalWebhookMessage).not.toHaveBeenCalled();
  });

  it('DM guard (no guild_id) → error reply, RPC not called', async () => {
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(makePollViewWith3Options())));
    const rpcStub = makeSyncRpcStub({ 'Poll/GetPollView': getPollViewFn });
    const restStub = makeRestStub();

    const noGuildInteraction: DiscordTypes.APIInteraction = {
      id: '1234567895' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      // guild_id absent
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      member: {
        user: {
          id: USER_DISCORD_ID,
          username: 'testuser',
          discriminator: '0001',
          global_name: null,
          avatar: null,
        },
        roles: [],
        joined_at: '2024-01-01T00:00:00Z',
        deaf: false,
        mute: false,
        permissions: '8',
      },
      locale: 'en-US',
      data: {
        component_type: 2,
        custom_id: `poll-remove:${POLL_ID}`,
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollRemoveButton, restStub.layer, rpcStub.layer, noGuildInteraction);

    // RPC must NOT be called in a DM context
    expect(getPollViewFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — PollRemoveSelectSubmit (TDD mode — handler does not exist yet)
// custom_id: poll-remove-select:{pollId}
// Receives data.values with selected option_ids, calls Poll/RemoveOptions,
// rebuilds board + sends confirmation webhook.
// ---------------------------------------------------------------------------

describe('PollRemoveSelectSubmit — poll-remove-select:{pollId}', () => {
  it('single selected value → calls Poll/RemoveOptions with option_ids:[that]', async () => {
    const removeOptionsFn = vi.fn(() => Effect.succeed(makePollViewWith3Options()));
    const rpcStub = makeSyncRpcStub({ 'Poll/RemoveOptions': removeOptionsFn });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(removeOptionsFn).toHaveBeenCalledWith(
      expect.objectContaining({
        poll_id: POLL_ID,
        option_ids: [OPTION_ID_A],
      }),
    );
  });

  it('multi-select (two values) → both ids passed to Poll/RemoveOptions', async () => {
    const removeOptionsFn = vi.fn(() => Effect.succeed(makePollViewWith3Options()));
    const rpcStub = makeSyncRpcStub({ 'Poll/RemoveOptions': removeOptionsFn });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [
      OPTION_ID_A,
      OPTION_ID_B,
    ]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(removeOptionsFn).toHaveBeenCalledWith(
      expect.objectContaining({
        poll_id: POLL_ID,
        option_ids: expect.arrayContaining([OPTION_ID_A, OPTION_ID_B]),
      }),
    );
  });

  it('happy path → board rebuilt (updateMessage called)', async () => {
    const removeOptionsFn = vi.fn(() => Effect.succeed(makePollViewWith3Options()));
    const rpcStub = makeSyncRpcStub({ 'Poll/RemoveOptions': removeOptionsFn });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });

  it('happy path → confirmation sent via updateOriginalWebhookMessage', async () => {
    const removeOptionsFn = vi.fn(() => Effect.succeed(makePollViewWith3Options()));
    const rpcStub = makeSyncRpcStub({ 'Poll/RemoveOptions': removeOptionsFn });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('PollForbidden → confirmation uses bot_poll_err_not_captain message; board NOT rebuilt', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/RemoveOptions': vi.fn(() => Effect.fail(new PollRpcModels.PollForbidden())),
    });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    // Board must NOT be rebuilt on forbidden
    expect(restStub.updateMessage).not.toHaveBeenCalled();
    // Ephemeral error must be sent with the not-captain message
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "Only captains and admins can do that."
    expect(payload).toContain('Only captains and admins can do that.');
  });

  it('PollTooFewOptions → bot_poll_err_min_options message; board NOT rebuilt', async () => {
    // bot_poll_err_min_options key does not exist yet (TDD) — assert it is distinct
    // from the generic error and is non-empty so a catch-all mapping cannot pass this test.
    const rpcStub = makeSyncRpcStub({
      'Poll/RemoveOptions': vi.fn(() => Effect.fail(new PollRpcModels.PollTooFewOptions())),
    });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // Must NOT map to the generic error — must be a distinct min-options message.
    // The exact English string is determined by the implementation (bot_poll_err_min_options).
    expect(payload).not.toContain('Something went wrong. Please try again.');
    // Must be non-trivially non-empty (a no-op handler would not produce content)
    expect(payload.length).toBeGreaterThan(50);
  });

  it('PollOptionNotFound → bot_poll_err_option_not_found message; board NOT rebuilt', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/RemoveOptions': vi.fn(() => Effect.fail(new PollRpcModels.PollOptionNotFound())),
    });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "That option no longer exists." (bot_poll_err_option_not_found)
    expect(payload).toContain('That option no longer exists.');
  });

  it('PollClosed → fetch view, rebuild board to CLOSED state (no poll-remove/poll-vote), send closed notice', async () => {
    const closedView = makePollView('closed');
    const getPollViewFn = vi.fn(() => Effect.succeed(Option.some(closedView)));
    const rpcStub = makeSyncRpcStub({
      'Poll/RemoveOptions': vi.fn(() => Effect.fail(new PollRpcModels.PollClosed())),
      'Poll/GetPollView': getPollViewFn,
    });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    // GetPollView must be called to fetch the current closed state
    expect(getPollViewFn).toHaveBeenCalled();

    // Board must be rebuilt — prove it used the CLOSED state by checking no open-only buttons
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
    const boardPayload = JSON.stringify(restStub.updateMessage.mock.calls[0]);
    // Closed board must NOT contain the remove or vote custom_ids
    expect(boardPayload).not.toContain('poll-remove:');
    expect(boardPayload).not.toContain('poll-vote:');

    // Confirmation notice must also be sent
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const confirmPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "This poll has already been closed." (bot_poll_closed_notice)
    expect(confirmPayload).toContain('This poll has already been closed.');
  });

  it('DM guard (no guild_id) → error reply, Poll/RemoveOptions not called', async () => {
    const removeOptionsFn = vi.fn(() => Effect.succeed(makePollViewWith3Options()));
    const rpcStub = makeSyncRpcStub({ 'Poll/RemoveOptions': removeOptionsFn });
    const restStub = makeRestStub();

    const noGuildInteraction: DiscordTypes.APIInteraction = {
      id: '1234567896' as DiscordTypes.Snowflake,
      application_id: APP_ID,
      token: INTERACTION_TOKEN,
      version: 1,
      type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
      // guild_id absent
      channel_id: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
      } as unknown as DiscordTypes.APIInteraction['channel'],
      member: {
        user: {
          id: USER_DISCORD_ID,
          username: 'testuser',
          discriminator: '0001',
          global_name: null,
          avatar: null,
        },
        roles: [],
        joined_at: '2024-01-01T00:00:00Z',
        deaf: false,
        mute: false,
        permissions: '8',
      },
      locale: 'en-US',
      data: {
        component_type: 3,
        custom_id: `poll-remove-select:${POLL_ID}`,
        values: [OPTION_ID_A],
      },
      message: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, noGuildInteraction);

    expect(removeOptionsFn).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('RpcClientError transport failure → bot_poll_err_generic message; board NOT rebuilt', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/RemoveOptions': vi.fn(() => Effect.fail({ _tag: 'RpcClientError' } as never)),
    });
    const restStub = makeRestStub();

    const interaction = makeSelectInteraction(`poll-remove-select:${POLL_ID}`, [OPTION_ID_A]);
    await runHandler(PollRemoveSelectSubmit, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // en: "Something went wrong. Please try again." (bot_poll_err_generic)
    expect(payload).toContain('Something went wrong. Please try again.');
  });
});
