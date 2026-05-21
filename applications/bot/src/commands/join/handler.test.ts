import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { joinHandler } from '~/commands/join/handler.js';

// ---------------------------------------------------------------------------
// DiscordREST stub helpers
// ---------------------------------------------------------------------------

interface RestStubOptions {
  addThreadMember?: ReturnType<typeof vi.fn>;
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const addThreadMember = options.addThreadMember ?? vi.fn(() => Effect.succeed(undefined));
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'addThreadMember') return addThreadMember;
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, addThreadMember, updateOriginalWebhookMessage };
};

// ---------------------------------------------------------------------------
// Interaction fixture
// ---------------------------------------------------------------------------

interface InteractionFixtureOptions {
  channelType?: number;
  channelId?: string | undefined;
  userOptionValue?: string | undefined;
  locale?: string;
}

const makeInteraction = (opts: InteractionFixtureOptions = {}): DiscordTypes.APIInteraction => {
  const channelType = opts.channelType ?? DiscordTypes.ChannelTypes.PUBLIC_THREAD;
  const channelId = opts.channelId === undefined ? 'thread-123' : opts.channelId;
  const userOptionValue = opts.userOptionValue;
  const locale = opts.locale ?? 'en-US';

  const options =
    userOptionValue === undefined
      ? []
      : [
          {
            type: DiscordTypes.ApplicationCommandOptionType.USER,
            name: 'user',
            value: userOptionValue,
          },
        ];

  return {
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: 'app-id-123' as DiscordTypes.Snowflake,
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND,
    guild_id: '9999999999' as DiscordTypes.Snowflake,
    channel_id: channelId as DiscordTypes.Snowflake | undefined,
    channel: channelId
      ? ({
          id: channelId as DiscordTypes.Snowflake,
          type: channelType,
        } as unknown as DiscordTypes.APIInteraction['channel'])
      : undefined,
    member: {
      user: {
        id: 'invoker-1' as DiscordTypes.Snowflake,
        username: 'invoker',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '0',
    },
    locale,
    data: {
      id: 'cmd-id' as DiscordTypes.Snowflake,
      name: 'join',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options,
    },
  } as unknown as DiscordTypes.APIInteraction;
};

const runHandler = async (
  interaction: DiscordTypes.APIInteraction,
  restLayer: Layer.Layer<DiscordREST>,
) => {
  const response = await Effect.runPromise(
    joinHandler.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(restLayer),
    ),
  );
  // The handler returns deferred immediately and forks the REST work in a
  // detached fiber. Yield a few microtasks so the forked work can settle
  // before assertions run on the stubs.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('joinHandler', () => {
  it('returns ephemeral "not a thread" message when invoked in a regular text channel', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.GUILD_TEXT,
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );

    const json = JSON.stringify(response);
    expect(json).toContain('thread');
    expect(json).toMatch(/64|ephemeral/i);
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('returns ephemeral "not a thread" when invoked in a category channel', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.GUILD_CATEGORY,
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );

    const json = JSON.stringify(response);
    expect(json).toContain('thread');
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('returns ephemeral "missing user" when user option is absent', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        userOptionValue: undefined,
      }),
      stub.layer,
    );

    const json = JSON.stringify(response);
    expect(json).toMatch(/64|ephemeral/i);
    expect(json.toLowerCase()).toContain('user');
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('defers and calls addThreadMember for a PUBLIC_THREAD', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        channelId: 'thread-123',
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );

    // Initial response is deferred + ephemeral
    expect(response).toEqual({
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    });

    // Forked work completes synchronously under runPromise — addThreadMember was called
    expect(stub.addThreadMember).toHaveBeenCalledWith('thread-123', 'target-1');
    expect(stub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);

    // The webhook update payload contains the user mention and the success text
    const updateCall = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    expect(JSON.stringify(updateCall)).toContain('<@target-1>');
  });

  it('works in a PRIVATE_THREAD', async () => {
    const stub = makeRestStub();
    await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PRIVATE_THREAD,
        channelId: 'thread-456',
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );
    expect(stub.addThreadMember).toHaveBeenCalledWith('thread-456', 'target-1');
  });

  it('works in an ANNOUNCEMENT_THREAD', async () => {
    const stub = makeRestStub();
    await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.ANNOUNCEMENT_THREAD,
        channelId: 'thread-789',
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );
    expect(stub.addThreadMember).toHaveBeenCalledWith('thread-789', 'target-1');
  });

  it('maps Discord HTTP 403 to bot_join_bot_forbidden', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          status: 403,
          code: 50013,
          message: 'Missing Permissions',
        }),
      ),
    });

    await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );

    const updateCall = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const payloadJson = JSON.stringify(updateCall);
    expect(payloadJson.toLowerCase()).toContain('permission');
  });

  it('maps Discord JSON code 50013 (without HTTP 403) to bot_join_bot_forbidden', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          status: 400,
          code: 50013,
          message: 'Missing Permissions',
        }),
      ),
    });

    await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );

    const updateCall = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const payloadJson = JSON.stringify(updateCall);
    expect(payloadJson.toLowerCase()).toContain('permission');
  });

  it('falls back to generic error message on non-permission ErrorResponse', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          status: 500,
          message: 'Internal Server Error',
        }),
      ),
    });

    await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );

    const updateCall = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const payloadJson = JSON.stringify(updateCall);
    // Should NOT contain "permission" — generic error wording differs in en
    expect(payloadJson.toLowerCase()).not.toContain('permission');
  });

  it('falls back to generic error on unknown REST failure', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'HttpClientError' as const,
          message: 'network unreachable',
        }),
      ),
    });

    await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        userOptionValue: 'target-1',
      }),
      stub.layer,
    );

    expect(stub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const updateCall = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    expect(updateCall).toBeDefined();
  });

  it('uses Czech locale strings when invoker locale is cs', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.GUILD_TEXT,
        userOptionValue: 'target-1',
        locale: 'cs',
      }),
      stub.layer,
    );

    const json = JSON.stringify(response);
    // Czech "vlákno" (thread) should appear in the response content
    expect(json).toContain('vlákn');
  });

  it('returns ephemeral missing-user message in Czech when locale is cs', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        userOptionValue: undefined,
        locale: 'cs',
      }),
      stub.layer,
    );

    const json = JSON.stringify(response);
    // Czech text should contain a Czech-specific letter (zadat / uživatele)
    expect(json).toMatch(/zadat|uživatele/);
  });
});
