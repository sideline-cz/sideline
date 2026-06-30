// createPersonalEventChannel tests.
// Function signature:
//   createPersonalEventChannel(guildId, discordUserId, categoryId, channelName) →
//     Effect<{discord_channel_id: Snowflake}, HttpClientError | RatelimitedResponse | ErrorResponse, DiscordREST | SyncRpc>
//
// The error channel is non-empty: Discord API errors (HttpClientError,
// RatelimitedResponse, ErrorResponse) propagate to the caller after the
// built-in retry policy is exhausted. See the "propagates Discord API error"
// test below for the expected rejection behaviour.

import { DiscordREST } from 'dfx/DiscordREST';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
// TDD: implement createPersonalEventChannel
import { createPersonalEventChannel } from '~/rest/channels/createPersonalEventChannel.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '500000000000000001';
const MEMBER_ID = '500000000000000002';
const CATEGORY_ID = '500000000000000003';
const CREATED_CHANNEL_ID = '500000000000000004';

// Discord permission bit constants (subset we care about)
const VIEW_CHANNEL = 1024n; // 1 << 10
const READ_MESSAGE_HISTORY = 65536n; // 1 << 16
const SEND_MESSAGES = 2048n; // 1 << 11
const ADD_REACTIONS = 64n; // 1 << 6
const CREATE_PUBLIC_THREADS = 34359738368n; // 1 << 35
const CREATE_PRIVATE_THREADS = 68719476736n; // 1 << 36

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface CreateGuildChannelCall {
  guildId: string;
  options: {
    name: string;
    type: number;
    parent_id?: string;
    permission_overwrites?: Array<{
      id: string;
      type: number;
      allow?: number | string;
      deny?: number | string;
    }>;
  };
}

const makeRestStub = (
  overrides: {
    createGuildChannel?: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
  } = {},
) => {
  const createGuildChannel =
    overrides.createGuildChannel ??
    vi.fn((_guildId: string, _options: unknown) =>
      Effect.succeed({
        id: CREATED_CHANNEL_ID,
        name: 'test-channel',
        type: DiscordTypes.ChannelTypes.GUILD_TEXT,
        parent_id: CATEGORY_ID,
      }),
    );

  const calls: { createGuildChannel: CreateGuildChannelCall[] } = { createGuildChannel: [] };

  const wrappedCreateGuildChannel = vi.fn((guildId: string, options: unknown) => {
    calls.createGuildChannel.push({
      guildId,
      options: options as CreateGuildChannelCall['options'],
    });
    return createGuildChannel(guildId, options);
  });

  const rest = new Proxy({} as any, {
    get: (_target: unknown, prop: string) => {
      if (prop === 'createGuildChannel') return wrappedCreateGuildChannel;
      return () => Effect.succeed({ id: 'mock-id', preferred_locale: 'en-US' });
    },
  });

  const layer = Layer.succeed(DiscordREST, rest as any);
  return { layer, calls, createGuildChannel: wrappedCreateGuildChannel };
};

const makeSyncRpcStub = () => {
  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: () => () => Effect.succeed(Option.none()),
    }),
  );
  return { layer };
};

const run = (
  effect: Effect.Effect<any, any, DiscordREST | SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(restLayer, rpcLayer))) as Effect.Effect<
      any,
      never,
      never
    >,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPersonalEventChannel', () => {
  it('calls createGuildChannel with parent_id set to the category', async () => {
    const { layer: restLayer, calls } = makeRestStub();
    const { layer: rpcLayer } = makeSyncRpcStub();

    await run(
      createPersonalEventChannel(
        GUILD_ID as any,
        MEMBER_ID as any,
        CATEGORY_ID as any,
        'personal-events',
      ),
      restLayer,
      rpcLayer,
    );

    expect(calls.createGuildChannel).toHaveLength(1);
    const call = calls.createGuildChannel[0];
    if (!call) throw new Error('Expected createGuildChannel to have been called');
    expect(call.guildId).toBe(GUILD_ID);
    expect(call.options.parent_id).toBe(CATEGORY_ID);
  });

  it('includes @everyone role overwrite that DENIES ViewChannel', async () => {
    const { layer: restLayer, calls } = makeRestStub();
    const { layer: rpcLayer } = makeSyncRpcStub();

    await run(
      createPersonalEventChannel(
        GUILD_ID as any,
        MEMBER_ID as any,
        CATEGORY_ID as any,
        'personal-events',
      ),
      restLayer,
      rpcLayer,
    );

    const overwrites = calls.createGuildChannel[0]?.options.permission_overwrites ?? [];
    // Find the @everyone overwrite (id = guildId, type = ROLE)
    const everyoneOverwrite = overwrites.find(
      (o) => o.id === GUILD_ID && o.type === DiscordTypes.ChannelPermissionOverwrites.ROLE,
    );
    expect(everyoneOverwrite).toBeDefined();
    // Must deny ViewChannel
    const denyBigInt = BigInt(everyoneOverwrite?.deny ?? 0);
    expect((denyBigInt & VIEW_CHANNEL) === VIEW_CHANNEL).toBe(true);
  });

  it('includes member overwrite of type MEMBER (1) that ALLOWS ViewChannel + ReadMessageHistory', async () => {
    const { layer: restLayer, calls } = makeRestStub();
    const { layer: rpcLayer } = makeSyncRpcStub();

    await run(
      createPersonalEventChannel(
        GUILD_ID as any,
        MEMBER_ID as any,
        CATEGORY_ID as any,
        'personal-events',
      ),
      restLayer,
      rpcLayer,
    );

    const overwrites = calls.createGuildChannel[0]?.options.permission_overwrites ?? [];
    // Find the member overwrite (id = discordUserId, type = MEMBER = 1)
    const memberOverwrite = overwrites.find(
      (o) => o.id === MEMBER_ID && o.type === DiscordTypes.ChannelPermissionOverwrites.MEMBER,
    );
    expect(memberOverwrite).toBeDefined();

    const allowBigInt = BigInt(memberOverwrite?.allow ?? 0);
    expect((allowBigInt & VIEW_CHANNEL) === VIEW_CHANNEL).toBe(true);
    expect((allowBigInt & READ_MESSAGE_HISTORY) === READ_MESSAGE_HISTORY).toBe(true);
  });

  it('member overwrite DENIES SendMessages, AddReactions, CreatePublicThreads, CreatePrivateThreads (read-only personal channel)', async () => {
    const { layer: restLayer, calls } = makeRestStub();
    const { layer: rpcLayer } = makeSyncRpcStub();

    await run(
      createPersonalEventChannel(
        GUILD_ID as any,
        MEMBER_ID as any,
        CATEGORY_ID as any,
        'personal-events',
      ),
      restLayer,
      rpcLayer,
    );

    const overwrites = calls.createGuildChannel[0]?.options.permission_overwrites ?? [];
    const memberOverwrite = overwrites.find(
      (o) => o.id === MEMBER_ID && o.type === DiscordTypes.ChannelPermissionOverwrites.MEMBER,
    );
    expect(memberOverwrite).toBeDefined();

    const denyBigInt = BigInt(memberOverwrite?.deny ?? 0);
    expect((denyBigInt & SEND_MESSAGES) === SEND_MESSAGES).toBe(true);
    expect((denyBigInt & ADD_REACTIONS) === ADD_REACTIONS).toBe(true);
    expect((denyBigInt & CREATE_PUBLIC_THREADS) === CREATE_PUBLIC_THREADS).toBe(true);
    expect((denyBigInt & CREATE_PRIVATE_THREADS) === CREATE_PRIVATE_THREADS).toBe(true);

    // Also assert the allow bitmask includes ViewChannel and ReadMessageHistory
    const allowBigInt = BigInt(memberOverwrite?.allow ?? 0);
    expect((allowBigInt & VIEW_CHANNEL) === VIEW_CHANNEL).toBe(true);
    expect((allowBigInt & READ_MESSAGE_HISTORY) === READ_MESSAGE_HISTORY).toBe(true);
  });

  it('returns the discord_channel_id of the created channel', async () => {
    const { layer: restLayer } = makeRestStub();
    const { layer: rpcLayer } = makeSyncRpcStub();

    const result = await run(
      createPersonalEventChannel(
        GUILD_ID as any,
        MEMBER_ID as any,
        CATEGORY_ID as any,
        'personal-events',
      ),
      restLayer,
      rpcLayer,
    );

    expect(result.discord_channel_id).toBe(CREATED_CHANNEL_ID);
  });

  it('creates channel as GUILD_TEXT type', async () => {
    const { layer: restLayer, calls } = makeRestStub();
    const { layer: rpcLayer } = makeSyncRpcStub();

    await run(
      createPersonalEventChannel(
        GUILD_ID as any,
        MEMBER_ID as any,
        CATEGORY_ID as any,
        'personal-events',
      ),
      restLayer,
      rpcLayer,
    );

    const call = calls.createGuildChannel[0];
    if (!call) throw new Error('Expected createGuildChannel to have been called');
    expect(call.options.type).toBe(DiscordTypes.ChannelTypes.GUILD_TEXT);
  });

  it('propagates Discord API error without swallowing it', async () => {
    const { layer: restLayer } = makeRestStub({
      createGuildChannel: vi.fn((..._args: unknown[]) =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 403 },
          data: { code: 50013, message: 'Missing Access' },
          message: 'Missing Access',
        }),
      ),
    });
    const { layer: rpcLayer } = makeSyncRpcStub();

    await expect(
      run(
        createPersonalEventChannel(
          GUILD_ID as any,
          MEMBER_ID as any,
          CATEGORY_ID as any,
          'personal-events',
        ),
        restLayer,
        rpcLayer,
      ),
    ).rejects.toBeDefined();
  }, 15_000); // retryPolicy: exponential(1s) x 3 recurs = up to 1+2+4 = 7 s; allow 15 s headroom
});
