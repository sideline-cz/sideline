// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { EmailForwarding, Team } from '@sideline/domain';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { EmailApproveButton, EmailRejectButton } from '~/interactions/email-approval.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '600000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '600000000000000010' as DiscordTypes.Snowflake;
const MESSAGE_ID = '600000000000000011' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '600000000000000030' as DiscordTypes.Snowflake;
const APP_ID = '600000000000000040' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-interaction-token';

const TEAM_ID = '00000000-0000-4000-8000-000000000010' as Team.TeamId;
const EMAIL_ID = '00000000-0000-4000-8000-000000000001' as EmailForwarding.EmailMessageId;

// Decode branded types
const decodeTeamId = Schema.decodeUnknownSync(Team.TeamId);
const decodeEmailId = Schema.decodeUnknownSync(EmailForwarding.EmailMessageId);

// ---------------------------------------------------------------------------
// Interaction fixture
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
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: {
      id: CHANNEL_ID,
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

interface RestStubOptions {
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
  updateMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));
  const updateMessage = options.updateMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      if (prop === 'updateMessage') return updateMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, updateOriginalWebhookMessage, updateMessage };
};

// ---------------------------------------------------------------------------
// SyncRpc stub
// ---------------------------------------------------------------------------

interface SyncRpcOptions {
  'Email/RecordApproval'?: ReturnType<typeof vi.fn>;
  'Email/RecordRejection'?: ReturnType<typeof vi.fn>;
}

const makeRpcStub = (options: SyncRpcOptions = {}) => {
  const defaults: Record<string, ReturnType<typeof vi.fn>> = {
    'Email/RecordApproval': vi.fn(() => Effect.succeed({ outcome: 'approved' })),
    'Email/RecordRejection': vi.fn(() => Effect.succeed({ outcome: 'rejected' })),
  };

  const rpc = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      return options[prop as keyof SyncRpcOptions] ?? defaults[prop];
    },
  });

  const layer = Layer.succeed(SyncRpc, rpc);
  return { layer, rpc, ...defaults, ...options };
};

// ---------------------------------------------------------------------------
// Run handler helper
// ---------------------------------------------------------------------------

/**
 * Run the `handle` Effect of a MessageComponent interaction handler.
 * Provides Interaction, MessageComponentData, DiscordREST, and SyncRpc.
 * After awaiting the response, flushes the microtask queue so `forkDetach`
 * side-effects (RPC calls, follow-up REST calls) have a chance to complete.
 */
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
// Tests — EmailApproveButton
// ---------------------------------------------------------------------------

describe('EmailApproveButton', () => {
  it('custom_id parsing — teamId and emailId are correctly extracted from parts[1]:parts[2]', async () => {
    const approveFn = vi.fn(() => Effect.succeed({ outcome: 'approved' }));
    const rpcStub = makeRpcStub({ 'Email/RecordApproval': approveFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-approve:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(approveFn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: decodeTeamId(TEAM_ID),
        email_id: decodeEmailId(EMAIL_ID),
        discord_user_id: USER_DISCORD_ID,
      }),
    );
  });

  it('happy path — returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE with Ephemeral flag immediately', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-approve:${TEAM_ID}:${EMAIL_ID}`);

    const response = await runHandler(
      EmailApproveButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect((response as any).data?.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });

  it('approved outcome — updateOriginalWebhookMessage called with follow-up content', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordApproval': vi.fn(() => Effect.succeed({ outcome: 'approved' })),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-approve:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('already_handled outcome — updateOriginalWebhookMessage called with already_handled content', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordApproval': vi.fn(() => Effect.succeed({ outcome: 'already_handled' })),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-approve:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('EmailApprovalForbidden — updateOriginalWebhookMessage called with not-authorized content', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordApproval': vi.fn(() =>
        Effect.fail({ _tag: 'EmailApprovalForbidden', message: 'Not a coach' } as any),
      ),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-approve:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('EmailRpcMessageNotFound — updateOriginalWebhookMessage called with not-found content', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordApproval': vi.fn(() =>
        Effect.fail({ _tag: 'EmailRpcMessageNotFound', message: 'Email not found' } as any),
      ),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-approve:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('approved — updateMessage called on original message to disable buttons', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordApproval': vi.fn(() => Effect.succeed({ outcome: 'approved' })),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-approve:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailApproveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — EmailRejectButton
// ---------------------------------------------------------------------------

describe('EmailRejectButton', () => {
  it('custom_id parsing — teamId and emailId are correctly extracted', async () => {
    const rejectFn = vi.fn(() => Effect.succeed({ outcome: 'rejected' }));
    const rpcStub = makeRpcStub({ 'Email/RecordRejection': rejectFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-reject:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailRejectButton, restStub.layer, rpcStub.layer, interaction);

    expect(rejectFn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: decodeTeamId(TEAM_ID),
        email_id: decodeEmailId(EMAIL_ID),
        discord_user_id: USER_DISCORD_ID,
      }),
    );
  });

  it('happy path — returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE with Ephemeral flag', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-reject:${TEAM_ID}:${EMAIL_ID}`);

    const response = await runHandler(
      EmailRejectButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect((response as any).data?.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });

  it('rejected outcome — updateOriginalWebhookMessage called', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordRejection': vi.fn(() => Effect.succeed({ outcome: 'rejected' })),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-reject:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailRejectButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('already_handled outcome — updateOriginalWebhookMessage called', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordRejection': vi.fn(() => Effect.succeed({ outcome: 'already_handled' })),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-reject:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailRejectButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('EmailApprovalForbidden — updateOriginalWebhookMessage called with not-authorized', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordRejection': vi.fn(() =>
        Effect.fail({ _tag: 'EmailApprovalForbidden', message: 'Not a coach' } as any),
      ),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-reject:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailRejectButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('EmailRpcMessageNotFound — updateOriginalWebhookMessage called with not-found', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordRejection': vi.fn(() =>
        Effect.fail({ _tag: 'EmailRpcMessageNotFound', message: 'Email not found' } as any),
      ),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-reject:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailRejectButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('rejected — updateMessage called on original message to disable buttons with allowed_mentions', async () => {
    const rpcStub = makeRpcStub({
      'Email/RecordRejection': vi.fn(() => Effect.succeed({ outcome: 'rejected' })),
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-reject:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailRejectButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });
});
