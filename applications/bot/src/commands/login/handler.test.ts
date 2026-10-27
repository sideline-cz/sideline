// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { loginHandler } from '~/commands/login/handler.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '910000000000000001';
const INVOKER_ID = '910000000000000030';
const LINK_URL = 'https://api.example.test/auth/link/Zm9vYmFyLXRva2Vu';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const makeRestStub = () => {
  const createMessage = vi.fn(() => Effect.succeed({ id: 'msg-1' }));
  const updateOriginalWebhookMessage = vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'createMessage') return createMessage;
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  return {
    layer: Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>),
    createMessage,
    updateOriginalWebhookMessage,
  };
};

const makeSyncRpcStub = (issueLoginLink?: ReturnType<typeof vi.fn>) => {
  const defaultIssue = vi.fn(() =>
    Effect.succeed({
      url: LINK_URL,
      expires_at: DateTime.makeUnsafe('2026-01-01T00:05:00Z'),
    }),
  );
  const issue = issueLoginLink ?? defaultIssue;

  const rpc = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      if (prop === 'Guild/IssueLoginLink') return issue;
      return () => Effect.succeed(undefined);
    },
  });

  return { layer: Layer.succeed(SyncRpc, rpc), issue };
};

const makeInteraction = (opts: { guildId?: string | undefined } = {}) =>
  ({
    id: '1234567890',
    application_id: 'app-id-123',
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND,
    guild_id: 'guildId' in opts ? opts.guildId : GUILD_ID,
    channel_id: 'channel-123',
    member: {
      user: { id: INVOKER_ID, username: 'invoker', discriminator: '0001', global_name: null },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '0',
    },
    locale: 'en-US',
    data: {
      id: 'cmd-id',
      name: 'login',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: [],
    },
  }) as unknown as DiscordTypes.APIInteraction;

const runHandler = async (
  interaction: DiscordTypes.APIInteraction,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) => {
  const response = await Effect.runPromise(
    loginHandler.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Delivery — the failure that would be worst
// ---------------------------------------------------------------------------

describe('loginHandler — ephemeral delivery is enforced, not intended', () => {
  // THE acceptance criterion. The handler's return value fixes the interaction's
  // visibility, and it does so before the token exists.
  it('returns a DEFERRED ack flagged Ephemeral', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub();

    const response = await runHandler(makeInteraction(), rest.layer, rpc.layer);

    expect(response).toEqual({
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    });
  });

  // The ordering IS the enforcement: no token can exist while a public response is
  // still reachable. Asserting the flag alone would not catch a refactor that minted
  // the token first and deferred afterwards.
  it('sets the ephemeral flag BEFORE the token is minted', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub();

    const response = await Effect.runPromise(
      loginHandler.pipe(
        Effect.provide(Layer.succeed(Interaction, makeInteraction())),
        Effect.provide(rest.layer),
        Effect.provide(rpc.layer),
      ),
    );

    expect(response).toEqual({
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    });
    expect(rpc.issue).not.toHaveBeenCalled();
  });

  // The regression guard that matters: `createMessage` posts to a CHANNEL. If someone
  // later adds a "post it publicly" branch, this goes red.
  it('never posts to a channel', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub();

    await runHandler(makeInteraction(), rest.layer, rpc.layer);

    expect(rest.createMessage).not.toHaveBeenCalled();
    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
  });

  // Discord fetches bare URLs in message content to build a preview. An unfurler GET
  // would REDEEM the single-use token before the user ever clicked it. The link may
  // only ride in a button `url` and an inline code span.
  it('never puts the link in bare message content', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub();

    await runHandler(makeInteraction(), rest.layer, rpc.layer);

    const payload = (rest.updateOriginalWebhookMessage.mock.calls[0] as any)[2].payload;
    expect(payload.content).toContain(`\`${LINK_URL}\``);
    expect(payload.content.replace(`\`${LINK_URL}\``, '')).not.toContain(LINK_URL);

    const button = payload.components[0].components[0];
    expect(button.style).toBe(DiscordTypes.ButtonStyleTypes.LINK);
    expect(button.url).toBe(LINK_URL);
  });
});

describe('loginHandler — issuance', () => {
  it('passes the invoking Discord user and guild to the RPC', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub();

    await runHandler(makeInteraction(), rest.layer, rpc.layer);

    expect(rpc.issue).toHaveBeenCalledTimes(1);
    expect((rpc.issue.mock.calls[0] as any)[0]).toEqual({
      discord_user_id: INVOKER_ID,
      guild_id: Option.some(GUILD_ID),
    });
  });

  it('works in a DM, where there is no guild', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub();

    await runHandler(makeInteraction({ guildId: undefined }), rest.layer, rpc.layer);

    expect((rpc.issue.mock.calls[0] as any)[0].guild_id).toEqual(Option.none());
  });

  it('tells an unregistered user to log in on the web once, and mints nothing', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub(
      vi.fn(() => Effect.fail({ _tag: 'LoginLinkUserNotFound' as const })),
    );

    await runHandler(makeInteraction(), rest.layer, rpc.layer);

    const payload = (rest.updateOriginalWebhookMessage.mock.calls[0] as any)[2].payload;
    expect(payload.content).toContain('Sideline account');
    expect(payload.components).toBeUndefined();
  });

  it('reports the retry window when rate limited', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub(
      vi.fn(() =>
        Effect.fail({ _tag: 'LoginLinkRateLimited' as const, retry_after_seconds: 1800 }),
      ),
    );

    await runHandler(makeInteraction(), rest.layer, rpc.layer);

    const payload = (rest.updateOriginalWebhookMessage.mock.calls[0] as any)[2].payload;
    expect(payload.content).toContain('30 min');
  });
});
