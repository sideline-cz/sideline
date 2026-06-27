// TDD mode — written BEFORE the implementation exists.
// Tests will fail to import until poll.ts interactions are implemented.
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
  PollVoteButton,
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
// Tests — poll-vote button
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

  it('CastVote action=counted → ephemeral success reply', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('counted', [OPTION_ID_A]))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('CastVote action=moved → ephemeral reply (different from counted)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('moved', [OPTION_ID_B]))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('CastVote action=retracted → ephemeral reply', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('retracted', []))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('CastVote action=added (multi) → ephemeral reply', async () => {
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

  it('CastVote action=removed (multi) → ephemeral reply', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.succeed(makeCastVoteResult('removed', [OPTION_ID_B]))),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('PollClosed from CastVote → ephemeral bot_poll_closed_notice (not an error, friendly message)', async () => {
    const rpcStub = makeSyncRpcStub({
      'Poll/CastVote': vi.fn(() => Effect.fail(new PollRpcModels.PollClosed())),
    });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const followUpPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // Should contain an ephemeral-flag-like response (not throwing, user-friendly)
    expect(followUpPayload.length).toBeGreaterThan(0);
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

    // Interaction with no member/user id
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

  it('vote button returns deferred ephemeral immediately (optimistic defer pattern)', async () => {
    const rpcStub = makeSyncRpcStub();
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-vote:${POLL_ID}:${OPTION_ID_A}`);
    const response = await runHandler(PollVoteButton, restStub.layer, rpcStub.layer, interaction);

    const responseJson = JSON.stringify(response);
    expect(responseJson).toContain(
      String(DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE),
    );
    // ephemeral flag (64)
    expect(responseJson).toContain(String(DiscordTypes.MessageFlags.Ephemeral));
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
    // custom_id must be poll-add-modal:{channelId}:{messageId}:{pollId}
    const expectedModalId = `poll-add-modal:${CHANNEL_ID}:${MESSAGE_ID}:${POLL_ID}`;
    expect(responseJson).toContain(expectedModalId);
  });

  it('add button does NOT call Poll/AddOption (modal is returned, no pre-gate)', async () => {
    const addOptionFn = vi.fn(() => Effect.succeed(makeAddOptionResult()));
    const rpcStub = makeSyncRpcStub({ 'Poll/AddOption': addOptionFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`poll-add:${POLL_ID}`);
    await runHandler(PollAddButton, restStub.layer, rpcStub.layer, interaction);

    // The add button must NOT call AddOption — that's for the modal submit
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

    // Modal custom_id: poll-add-modal:{channel}:{message}:{pollId}
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
        // CRITICAL: member_role_ids must be the EXACT raw array from interaction.member.roles
        // It must never be a boolean or transformed value
        member_role_ids: EXACT_ROLE_IDS,
      }),
    );
    // Additional explicit assertion: the value is an array, never a boolean
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
    // Board must be updated at the stored channel/message ids from the view
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
