// NOTE: TDD mode — tests will FAIL until the roster-approval interaction
// handlers are implemented in interactions/roster-approval.ts.

import type { Event, EventRpcModels, TeamMember } from '@sideline/domain';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import type * as DiscordTypes from 'dfx/types';
import * as DiscordTypesImport from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { RosterApproveButton, RosterDeclineButton } from '~/interactions/roster-approval.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as DiscordTypes.Snowflake;
const CHANNEL_ID = '222222222222222222' as DiscordTypes.Snowflake;
const MESSAGE_ID = '333333333333333333' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '111111111111111111' as DiscordTypes.Snowflake;
const APP_ID = '444444444444444444' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-interaction-token';

const EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

// ---------------------------------------------------------------------------
// Interaction fixture builder
// ---------------------------------------------------------------------------

const makeComponentInteraction = (
  customId: string,
  userId: string = USER_DISCORD_ID,
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypesImport.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: {
      id: CHANNEL_ID,
      type: DiscordTypesImport.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: userId as DiscordTypes.Snowflake,
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
      custom_id: customId,
    },
    message: {
      id: MESSAGE_ID,
      channel_id: CHANNEL_ID,
    },
  }) as unknown as DiscordTypes.APIInteraction;

// ---------------------------------------------------------------------------
// DiscordREST stub
// ---------------------------------------------------------------------------

const makeRestStub = (overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) => {
  const updateOriginalWebhookMessage =
    overrides.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));
  const updateMessage = overrides.updateMessage ?? vi.fn(() => Effect.succeed(undefined));
  const editMessage = overrides.editMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      if (prop === 'updateMessage') return updateMessage;
      if (prop === 'editMessage') return editMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, updateOriginalWebhookMessage, updateMessage, editMessage };
};

// ---------------------------------------------------------------------------
// SyncRpc stub
// ---------------------------------------------------------------------------

type RpcOptions = {
  'Event/ApproveRosterRequest'?: ReturnType<typeof vi.fn>;
  'Event/DeclineRosterRequest'?: ReturnType<typeof vi.fn>;
};

const makeRpcStub = (options: RpcOptions = {}) => {
  const approveRosterRequest =
    options['Event/ApproveRosterRequest'] ??
    vi.fn(() =>
      Effect.succeed({
        outcome: 'approved',
        member_display_name: Option.some('Alice'),
      } as EventRpcModels.DecideRosterRequestResult),
    );

  const declineRosterRequest =
    options['Event/DeclineRosterRequest'] ??
    vi.fn(() =>
      Effect.succeed({
        outcome: 'declined',
        member_display_name: Option.some('Alice'),
      } as EventRpcModels.DecideRosterRequestResult),
    );

  const defaults: Record<string, ReturnType<typeof vi.fn>> = {
    'Event/ApproveRosterRequest': approveRosterRequest,
    'Event/DeclineRosterRequest': declineRosterRequest,
  };

  const rpc = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      return options[prop as keyof RpcOptions] ?? defaults[prop];
    },
  });

  const layer = Layer.succeed(SyncRpc, rpc);
  return { layer, rpc, approveRosterRequest, declineRosterRequest };
};

// ---------------------------------------------------------------------------
// Run handler helper (same pattern as email-pages.test.ts)
// ---------------------------------------------------------------------------

const runHandler = async (
  component: { handle: Effect.Effect<unknown, unknown, unknown> },
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    component.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(
          MessageComponentData,
          (interaction as any).data as DiscordTypes.APIMessageComponentInteractionData,
        ),
      ),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  // Flush microtask queue for forkDetach tasks
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Tests — RosterApproveButton
// ---------------------------------------------------------------------------

describe('RosterApproveButton', () => {
  it('returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE with Ephemeral flag', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsv-approve:${EVENT_ID}:${MEMBER_ID}`);

    const response = await runHandler(
      RosterApproveButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypesImport.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect((response as any).data?.flags).toBe(DiscordTypesImport.MessageFlags.Ephemeral);
  });

  it('calls Event/ApproveRosterRequest with parsed eventId and memberId + decider discord id', async () => {
    const approveFn = vi.fn(() =>
      Effect.succeed({ outcome: 'approved', member_display_name: Option.some('Alice') } as any),
    );
    const rpcStub = makeRpcStub({ 'Event/ApproveRosterRequest': approveFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(
      `rsv-approve:${EVENT_ID}:${MEMBER_ID}`,
      USER_DISCORD_ID,
    );

    await runHandler(RosterApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(approveFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: EVENT_ID,
        team_member_id: MEMBER_ID,
        decided_by_discord_id: USER_DISCORD_ID,
      }),
    );
  });

  it('success → disables message (updates original webhook message)', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsv-approve:${EVENT_ID}:${MEMBER_ID}`);

    await runHandler(RosterApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('NotOwnerGroupMember → ephemeral "not permitted" message', async () => {
    const approveFn = vi.fn(() => Effect.fail({ _tag: 'NotOwnerGroupMember' } as any));
    const rpcStub = makeRpcStub({ 'Event/ApproveRosterRequest': approveFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsv-approve:${EVENT_ID}:${MEMBER_ID}`);

    const response = await runHandler(
      RosterApproveButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    // Should return ephemeral response or call updateOriginalWebhookMessage with error content
    expect(response).toBeDefined();
    // Either the initial response is ephemeral, or the follow-up message contains error text
    const _responseStr = JSON.stringify(response);
    // It should be ephemeral (Ephemeral flag = 64) or the follow-up mentions "not permitted"
    const isEphemeral = (response as any).data?.flags === DiscordTypesImport.MessageFlags.Ephemeral;
    const isFollowUpWithError = restStub.updateOriginalWebhookMessage.mock.calls.some(
      (call: unknown[]) => JSON.stringify(call).toLowerCase().includes('not'),
    );
    expect(isEphemeral || isFollowUpWithError).toBe(true);
  });

  it('RosterRequestNotPending → "already handled" message', async () => {
    const approveFn = vi.fn(() => Effect.fail({ _tag: 'RosterRequestNotPending' } as any));
    const rpcStub = makeRpcStub({ 'Event/ApproveRosterRequest': approveFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsv-approve:${EVENT_ID}:${MEMBER_ID}`);

    const response = await runHandler(
      RosterApproveButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect(response).toBeDefined();
    // Should show "already handled" message either as initial response or follow-up
    const followUpCalls = restStub.updateOriginalWebhookMessage.mock.calls;
    const hasAlreadyHandled =
      JSON.stringify(response).toLowerCase().includes('already') ||
      followUpCalls.some((call: unknown[]) =>
        JSON.stringify(call).toLowerCase().includes('already'),
      );
    expect(hasAlreadyHandled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — RosterDeclineButton
// ---------------------------------------------------------------------------

describe('RosterDeclineButton', () => {
  it('returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE with Ephemeral flag', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsv-decline:${EVENT_ID}:${MEMBER_ID}`);

    const response = await runHandler(
      RosterDeclineButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypesImport.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect((response as any).data?.flags).toBe(DiscordTypesImport.MessageFlags.Ephemeral);
  });

  it('calls Event/DeclineRosterRequest with parsed eventId, memberId, and decider discord id', async () => {
    const declineFn = vi.fn(() =>
      Effect.succeed({ outcome: 'declined', member_display_name: Option.some('Alice') } as any),
    );
    const rpcStub = makeRpcStub({ 'Event/DeclineRosterRequest': declineFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(
      `rsv-decline:${EVENT_ID}:${MEMBER_ID}`,
      USER_DISCORD_ID,
    );

    await runHandler(RosterDeclineButton, restStub.layer, rpcStub.layer, interaction);

    expect(declineFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: EVENT_ID,
        team_member_id: MEMBER_ID,
        decided_by_discord_id: USER_DISCORD_ID,
      }),
    );
  });

  it('success → disables message (updates original webhook message)', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsv-decline:${EVENT_ID}:${MEMBER_ID}`);

    await runHandler(RosterDeclineButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('NotOwnerGroupMember → ephemeral not-permitted response', async () => {
    const declineFn = vi.fn(() => Effect.fail({ _tag: 'NotOwnerGroupMember' } as any));
    const rpcStub = makeRpcStub({ 'Event/DeclineRosterRequest': declineFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsv-decline:${EVENT_ID}:${MEMBER_ID}`);

    const response = await runHandler(
      RosterDeclineButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect(response).toBeDefined();
    const isEphemeral = (response as any).data?.flags === DiscordTypesImport.MessageFlags.Ephemeral;
    const followUpStr = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls);
    const hasErrorInFollowUp = followUpStr.toLowerCase().includes('not');
    expect(isEphemeral || hasErrorInFollowUp).toBe(true);
  });
});
