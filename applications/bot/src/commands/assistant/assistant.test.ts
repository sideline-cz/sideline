// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { AssistantRpcModels } from '@sideline/domain';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { assistantHandler } from '~/commands/assistant/handler.js';
import { buildHistory, splitMessage } from '~/commands/assistant/render.js';
import { handleAssistantMessage } from '~/commands/assistant/thread.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '910000000000000001';
const OWNER_ID = '910000000000000030';
const OTHER_ID = '910000000000000031';
const BOT_ID = '910000000000000099';
const THREAD_ID = '910000000000000500';

const makeRest = (messages: ReadonlyArray<unknown> = []) => {
  const fns = {
    createThread: vi.fn(() => Effect.succeed({ id: THREAD_ID, type: 12 })),
    addThreadMember: vi.fn(() => Effect.succeed(undefined)),
    createMessage: vi.fn(() => Effect.succeed({ id: 'msg-1' })),
    updateOriginalWebhookMessage: vi.fn(() => Effect.succeed(undefined)),
    listMessages: vi.fn(() => Effect.succeed(messages)),
    triggerTypingIndicator: vi.fn(() => Effect.succeed(undefined)),
    deleteChannel: vi.fn(() => Effect.succeed(undefined)),
  };
  const rest = new Proxy({} as DiscordRestService, {
    get: (_t, prop: string) =>
      prop in fns ? fns[prop as keyof typeof fns] : () => Effect.succeed(undefined),
  });
  return {
    fns,
    layer: Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>),
  };
};

const makeRpc = (handlers: Record<string, ReturnType<typeof vi.fn>>) => {
  const rpc = new Proxy({} as any, {
    get: (_t, prop: string) =>
      typeof prop !== 'string' || prop === 'then'
        ? undefined
        : (handlers[prop] ?? (() => Effect.succeed(undefined))),
  });
  return Layer.succeed(SyncRpc, rpc);
};

const makeInteraction = (visibility?: 'private' | 'public') =>
  ({
    id: '1',
    application_id: 'app-id',
    token: 'token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND,
    guild_id: GUILD_ID,
    channel_id: '910000000000000400',
    member: {
      user: { id: OWNER_ID, username: 'owner', discriminator: '0', global_name: 'Owner' },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '0',
    },
    locale: 'en-US',
    data: {
      id: 'cmd',
      name: 'assistant',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: visibility === undefined ? [] : [{ name: 'visibility', type: 3, value: visibility }],
    },
  }) as unknown as DiscordTypes.APIInteraction;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const runCommand = async (
  interaction: DiscordTypes.APIInteraction,
  rest: ReturnType<typeof makeRest>,
  rpc: Layer.Layer<SyncRpc>,
) => {
  const response = await Effect.runPromise(
    assistantHandler.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(rest.layer),
      Effect.provide(rpc),
    ),
  );
  await flush();
  return response;
};

describe('/assistant command', () => {
  it('refuses an unlinked user ephemerally and creates no thread', async () => {
    const rest = makeRest();
    const register = vi.fn(() => Effect.void);
    const rpc = makeRpc({
      'Assistant/Authorize': vi.fn(() => Effect.fail(new AssistantRpcModels.AssistantNotLinked())),
      'Assistant/RegisterThread': register,
    });

    const response = await runCommand(makeInteraction(), rest, rpc);

    expect(response).toEqual({
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    });
    expect(rest.fns.createThread).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    const [, , { payload }] = rest.fns.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      string,
      string,
      { payload: { content: string } },
    ];
    expect(payload.content).toContain('/login');
  });

  it('refuses a non-member with no thread', async () => {
    const rest = makeRest();
    const rpc = makeRpc({
      'Assistant/Authorize': vi.fn(() => Effect.fail(new AssistantRpcModels.AssistantNotMember())),
    });

    await runCommand(makeInteraction(), rest, rpc);

    expect(rest.fns.createThread).not.toHaveBeenCalled();
    expect(rest.fns.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, DiscordTypes.ChannelTypes.PRIVATE_THREAD],
    ['private', DiscordTypes.ChannelTypes.PRIVATE_THREAD],
    ['public', DiscordTypes.ChannelTypes.PUBLIC_THREAD],
  ] as const)(
    'visibility=%s opens a thread of type %i and registers it',
    async (visibility, type) => {
      const rest = makeRest();
      const register = vi.fn(() => Effect.void);
      const rpc = makeRpc({
        'Assistant/Authorize': vi.fn(() => Effect.succeed({ enabled: true })),
        'Assistant/RegisterThread': register,
      });

      await runCommand(makeInteraction(visibility), rest, rpc);

      expect(rest.fns.createThread).toHaveBeenCalledWith(
        '910000000000000400',
        expect.objectContaining({ type }),
      );
      expect(register).toHaveBeenCalledWith({
        guild_id: GUILD_ID,
        discord_user_id: OWNER_ID,
        thread_id: THREAD_ID,
      });
      expect(rest.fns.addThreadMember).toHaveBeenCalledWith(THREAD_ID, OWNER_ID);
      // Greeting in the thread, mentioning only the owner.
      expect(rest.fns.createMessage).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ allowed_mentions: { users: [OWNER_ID] } }),
      );
    },
  );

  it('opens nothing when the assistant is disabled', async () => {
    const rest = makeRest();
    const rpc = makeRpc({ 'Assistant/Authorize': vi.fn(() => Effect.succeed({ enabled: false })) });

    await runCommand(makeInteraction(), rest, rpc);

    expect(rest.fns.createThread).not.toHaveBeenCalled();
  });
});

describe('assistant thread messages', () => {
  const ownerLookup = () =>
    vi.fn(() => Effect.succeed({ owner_discord_id: OWNER_ID, locale: 'en' as const }));
  const turn = () =>
    vi.fn(() =>
      Effect.succeed({ answer: 'There are 3 events.', degraded_reason: null, proposal: null }),
    );

  const run = (
    message: Parameters<typeof handleAssistantMessage>[0],
    rest: ReturnType<typeof makeRest>,
    rpc: Layer.Layer<SyncRpc>,
  ) =>
    Effect.runPromise(
      handleAssistantMessage(message).pipe(Effect.provide(rest.layer), Effect.provide(rpc)),
    );

  it("forwards the owner's message with the thread history and posts the reply", async () => {
    const rest = makeRest([
      { author: { id: OWNER_ID }, content: 'how many events?' },
      { author: { id: BOT_ID, bot: true }, content: 'Hi! I am the assistant.' },
    ]);
    const chat = turn();
    const rpc = makeRpc({ 'Assistant/GetThreadOwner': ownerLookup(), 'Assistant/Chat': chat });

    await run(
      {
        channel_id: '910000000000000601',
        guild_id: GUILD_ID,
        author: { id: OWNER_ID },
        content: 'how many events?',
      },
      rest,
      rpc,
    );

    expect(chat).toHaveBeenCalledTimes(1);
    const [payload] = chat.mock.calls[0] as unknown as [
      { thread_id: string; messages: ReadonlyArray<{ role: string; content: string }> },
    ];
    expect(payload.thread_id).toBe('910000000000000601');
    // The greeting before the first user turn is dropped.
    expect(payload.messages.map((x) => [x.role, x.content])).toEqual([
      ['user', 'how many events?'],
    ]);
    expect(rest.fns.createMessage).toHaveBeenCalledWith(
      '910000000000000601',
      expect.objectContaining({ content: 'There are 3 events.' }),
    );
  });

  it("ignores another user's message in a public thread", async () => {
    const rest = makeRest();
    const chat = turn();
    const rpc = makeRpc({ 'Assistant/GetThreadOwner': ownerLookup(), 'Assistant/Chat': chat });

    await run(
      {
        channel_id: '910000000000000602',
        guild_id: GUILD_ID,
        author: { id: OTHER_ID },
        content: 'hello?',
      },
      rest,
      rpc,
    );

    expect(chat).not.toHaveBeenCalled();
    expect(rest.fns.createMessage).not.toHaveBeenCalled();
  });

  it('ignores channels that are not assistant threads, and asks the server only once', async () => {
    const rest = makeRest();
    const lookup = vi.fn(() => Effect.succeed(null));
    const chat = turn();
    const rpc = makeRpc({ 'Assistant/GetThreadOwner': lookup, 'Assistant/Chat': chat });
    const message = {
      channel_id: '910000000000000603',
      guild_id: GUILD_ID,
      author: { id: OWNER_ID },
      content: 'hi',
    };

    await run(message, rest, rpc);
    await run(message, rest, rpc);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it('ignores bot messages without a lookup', async () => {
    const rest = makeRest();
    const lookup = ownerLookup();
    const rpc = makeRpc({ 'Assistant/GetThreadOwner': lookup });

    await run(
      {
        channel_id: '910000000000000604',
        guild_id: GUILD_ID,
        author: { id: BOT_ID, bot: true },
        content: 'reply',
      },
      rest,
      rpc,
    );

    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('render helpers', () => {
  it('splits long replies into chunks of at most 2000 chars', () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`)
      .join(' ')
      .repeat(3);
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('joins split bot replies into one assistant turn and keeps only owner/bot messages', () => {
    const newestFirst = [
      { author: { id: OWNER_ID }, content: 'thanks' },
      { author: { id: BOT_ID, bot: true }, content: 'part 2' },
      { author: { id: BOT_ID, bot: true }, content: 'part 1' },
      { author: { id: OTHER_ID }, content: 'butting in' },
      { author: { id: OWNER_ID }, content: 'question' },
    ];
    expect(buildHistory(newestFirst, OWNER_ID)).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'part 1\n\npart 2' },
      { role: 'user', content: 'thanks' },
    ]);
  });
});
