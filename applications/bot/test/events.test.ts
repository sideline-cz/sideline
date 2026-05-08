import { Discord as DomainDiscord } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DiscordGateway } from 'dfx/gateway';
import * as Discord from 'dfx/types';
import { Effect, Layer, Option, References } from 'effect';
import { describe, expect, it } from 'vitest';
import { eventHandlers } from '~/events/index.js';
import { InviteCache } from '~/services/InviteCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const makeRecordingGateway = () => {
  const registeredEvents: string[] = [];

  const layer = Layer.succeed(DiscordGateway, {
    [DiscordGateway.key]: DiscordGateway.key,
    dispatch: undefined as never,
    fromDispatch: undefined as never,
    handleDispatch: (event: string, _handle: unknown) => {
      registeredEvents.push(event);
      return Effect.never;
    },
    send: undefined as never,
    shards: Effect.succeed(new Set()),
  } as never);

  return { registeredEvents, layer };
};

/**
 * A gateway that captures each registered handler so tests can invoke them
 * directly. Returns Effect.void (not Effect.never) so eventHandlers completes.
 */
const makeCapturingGateway = () => {
  const handlers = new Map<string, (payload: unknown) => Effect.Effect<void>>();

  const layer = Layer.succeed(DiscordGateway, {
    [DiscordGateway.key]: DiscordGateway.key,
    dispatch: undefined as never,
    fromDispatch: undefined as never,
    handleDispatch: (event: string, handle: (payload: unknown) => Effect.Effect<void>) => {
      handlers.set(event, handle);
      return Effect.void;
    },
    send: undefined as never,
    shards: Effect.succeed(new Set()),
  } as never);

  const dispatch = (event: string, payload: unknown): Effect.Effect<void> => {
    const handler = handlers.get(event);
    if (!handler) return Effect.die(new Error(`No handler registered for ${event}`));
    return handler(payload);
  };

  return { handlers, layer, dispatch };
};

const MockSyncRpcLayer = Layer.succeed(
  SyncRpc,
  new Proxy({} as any, {
    get: () => () => Effect.void,
  }),
);

const MockDiscordRESTLayer = Layer.succeed(
  DiscordREST,
  new Proxy({} as never, {
    get: () => () => Effect.succeed([]),
  }),
);

const MockInviteCacheLayer = Layer.succeed(InviteCache, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  snapshot: () => Effect.succeed(new Map<string, number>()),
  diffOnMemberJoin: () => Effect.succeed(Option.none()),
} as any);

const MockLayers = Layer.mergeAll(MockSyncRpcLayer, MockDiscordRESTLayer, MockInviteCacheLayer);

describe('events', () => {
  it('registers handlers for expected gateway events', async () => {
    const { registeredEvents, layer } = makeRecordingGateway();

    await Effect.runPromise(
      eventHandlers.pipe(
        Effect.timeout('100 millis'),
        Effect.ignore,
        Effect.provide(Layer.merge(layer, MockLayers)),
        Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
      ),
    );

    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.GuildCreate);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.GuildDelete);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.GuildMemberAdd);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.GuildMemberRemove);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.GuildMemberUpdate);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.ChannelCreate);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.ChannelDelete);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.ChannelUpdate);
    // InviteCreate and InviteDelete added in Phase 5
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.InviteCreate);
    expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.InviteDelete);
    expect(registeredEvents).toHaveLength(10);
  });

  it('returns the correct number of handler effects', async () => {
    const { layer } = makeRecordingGateway();

    const result = await Effect.runPromise(
      eventHandlers.pipe(
        Effect.timeout('100 millis'),
        Effect.provide(Layer.merge(layer, MockLayers)),
        Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
      ),
    );

    expect(Array.isArray(result)).toBe(true);
  });

  describe('channel handlers', () => {
    /** Builds a recording SyncRpc and runs eventHandlers with the capturing gateway. */
    const setup = async () => {
      const calls: { method: string; args: unknown }[] = [];

      const RecordingSyncRpcLayer = Layer.succeed(
        SyncRpc,
        new Proxy({} as any, {
          get: (_target: unknown, method: string) => (args: unknown) => {
            calls.push({ method, args });
            return Effect.void;
          },
        }),
      );

      const { layer: gatewayLayer, dispatch } = makeCapturingGateway();

      await Effect.runPromise(
        eventHandlers.pipe(
          Effect.provide(
            Layer.mergeAll(
              gatewayLayer,
              RecordingSyncRpcLayer,
              MockDiscordRESTLayer,
              MockInviteCacheLayer,
            ),
          ),
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      return { calls, dispatch };
    };

    const syncableTextChannel = {
      id: '111111111',
      guild_id: '222222222',
      name: 'general',
      type: 0,
      parent_id: null,
    };

    const syncableCategoryChannel = {
      id: '444444444',
      guild_id: '222222222',
      name: 'Category',
      type: 4,
      parent_id: null,
    };

    const nonSyncableVoiceChannel = {
      id: '333333333',
      guild_id: '222222222',
      name: 'voice-chat',
      type: 2,
      parent_id: null,
    };

    it('ChannelCreate with a syncable text channel calls Guild/UpsertChannel', async () => {
      const { calls, dispatch } = await setup();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.ChannelCreate, syncableTextChannel).pipe(
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      const upsertCalls = calls.filter((c) => c.method === 'Guild/UpsertChannel');
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].args).toMatchObject({
        channel_id: DomainDiscord.Snowflake.makeUnsafe('111111111'),
        guild_id: DomainDiscord.Snowflake.makeUnsafe('222222222'),
        name: 'general',
        type: 0,
        parent_id: Option.none(),
      });
    });

    it('ChannelCreate with a syncable category channel calls Guild/UpsertChannel', async () => {
      const { calls, dispatch } = await setup();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.ChannelCreate, syncableCategoryChannel).pipe(
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      const upsertCalls = calls.filter((c) => c.method === 'Guild/UpsertChannel');
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].args).toMatchObject({
        channel_id: DomainDiscord.Snowflake.makeUnsafe('444444444'),
        name: 'Category',
        type: 4,
      });
    });

    it('ChannelCreate with a non-syncable voice channel does NOT call Guild/UpsertChannel', async () => {
      const { calls, dispatch } = await setup();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.ChannelCreate, nonSyncableVoiceChannel).pipe(
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      const upsertCalls = calls.filter((c) => c.method === 'Guild/UpsertChannel');
      expect(upsertCalls).toHaveLength(0);
    });

    it('ChannelDelete with a syncable channel calls Guild/DeleteChannel', async () => {
      const { calls, dispatch } = await setup();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.ChannelDelete, syncableTextChannel).pipe(
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      const deleteCalls = calls.filter((c) => c.method === 'Guild/DeleteChannel');
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args).toMatchObject({
        channel_id: DomainDiscord.Snowflake.makeUnsafe('111111111'),
        guild_id: DomainDiscord.Snowflake.makeUnsafe('222222222'),
      });
    });

    it('ChannelDelete with a non-syncable voice channel does NOT call Guild/DeleteChannel', async () => {
      const { calls, dispatch } = await setup();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.ChannelDelete, nonSyncableVoiceChannel).pipe(
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      const deleteCalls = calls.filter((c) => c.method === 'Guild/DeleteChannel');
      expect(deleteCalls).toHaveLength(0);
    });

    it('ChannelUpdate with a syncable channel calls Guild/UpsertChannel', async () => {
      const { calls, dispatch } = await setup();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.ChannelUpdate, syncableTextChannel).pipe(
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      const upsertCalls = calls.filter((c) => c.method === 'Guild/UpsertChannel');
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].args).toMatchObject({
        channel_id: DomainDiscord.Snowflake.makeUnsafe('111111111'),
        guild_id: DomainDiscord.Snowflake.makeUnsafe('222222222'),
        name: 'general',
        type: 0,
      });
    });

    it('ChannelUpdate with a non-syncable voice channel does NOT call Guild/UpsertChannel', async () => {
      const { calls, dispatch } = await setup();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.ChannelUpdate, nonSyncableVoiceChannel).pipe(
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      const upsertCalls = calls.filter((c) => c.method === 'Guild/UpsertChannel');
      expect(upsertCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Invite cache event handler tests (TDD — added before Phase 5 implementation)
  // -------------------------------------------------------------------------

  describe('invite cache handlers', () => {
    /**
     * Builds a recording InviteCache + recording SyncRpc and runs eventHandlers
     * with the capturing gateway.
     */
    const setupWithInviteCache = async (
      diffResult: Option.Option<string> = Option.none(),
      syncRpcReturnValue: unknown = Option.none(),
    ) => {
      const inviteCacheCalls: { method: string; args: unknown[] }[] = [];
      const syncRpcCalls: { method: string; args: unknown }[] = [];

      const RecordingInviteCacheLayer = Layer.succeed(InviteCache, {
        upsert: (guildId: string, code: string, uses: number) => {
          inviteCacheCalls.push({ method: 'upsert', args: [guildId, code, uses] });
          return Effect.void;
        },
        remove: (guildId: string, code: string) => {
          inviteCacheCalls.push({ method: 'remove', args: [guildId, code] });
          return Effect.void;
        },
        snapshot: () => Effect.succeed(new Map<string, number>()),
        diffOnMemberJoin: (_guildId: string, _fresh: unknown) => {
          inviteCacheCalls.push({ method: 'diffOnMemberJoin', args: [_guildId, _fresh] });
          return Effect.succeed(diffResult);
        },
      } as any);

      const RecordingSyncRpcLayer = Layer.succeed(
        SyncRpc,
        new Proxy({} as any, {
          get: (_target: unknown, method: string) => (args: unknown) => {
            syncRpcCalls.push({ method, args });
            return Effect.succeed(syncRpcReturnValue);
          },
        }),
      );

      const { layer: gatewayLayer, dispatch } = makeCapturingGateway();

      await Effect.runPromise(
        eventHandlers.pipe(
          Effect.provide(
            Layer.mergeAll(
              gatewayLayer,
              RecordingSyncRpcLayer,
              MockDiscordRESTLayer,
              RecordingInviteCacheLayer,
            ),
          ),
          Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
        ),
      );

      return { inviteCacheCalls, syncRpcCalls, dispatch };
    };

    it('InviteCreate event → InviteCache.upsert called with guildId, code, uses', async () => {
      const { inviteCacheCalls, dispatch } = await setupWithInviteCache();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.InviteCreate, {
          guild_id: '999999999999999999',
          code: 'INVITE-CODE',
          uses: 0,
          channel_id: '111111111111111111',
        }).pipe(Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None'))),
      );

      const upsertCalls = inviteCacheCalls.filter((c) => c.method === 'upsert');
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].args[0]).toBe('999999999999999999');
      expect(upsertCalls[0].args[1]).toBe('INVITE-CODE');
    });

    it('InviteDelete event → InviteCache.remove called with guildId, code', async () => {
      const { inviteCacheCalls, dispatch } = await setupWithInviteCache();

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.InviteDelete, {
          guild_id: '999999999999999999',
          code: 'DELETED-CODE',
          channel_id: '111111111111111111',
        }).pipe(Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None'))),
      );

      const removeCalls = inviteCacheCalls.filter((c) => c.method === 'remove');
      expect(removeCalls).toHaveLength(1);
      expect(removeCalls[0].args[0]).toBe('999999999999999999');
      expect(removeCalls[0].args[1]).toBe('DELETED-CODE');
    });

    it('GuildMemberAdd with cache returning Some(CODE) → RegisterMember called with invite_code: Some(CODE)', async () => {
      const { syncRpcCalls, dispatch } = await setupWithInviteCache(Option.some('WINNER-CODE'));

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.GuildMemberAdd, {
          guild_id: '999999999999999999',
          user: {
            id: '200000000000000001',
            username: 'new-member',
            bot: false,
            global_name: null,
            avatar: null,
          },
          roles: [],
          nick: null,
        }).pipe(Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None'))),
      );

      const registerCalls = syncRpcCalls.filter((c) => c.method === 'Guild/RegisterMember');
      expect(registerCalls).toHaveLength(1);
      const args = registerCalls[0].args as any;
      expect(Option.isSome(args.invite_code)).toBe(true);
      expect(Option.getOrNull(args.invite_code)).toBe('WINNER-CODE');
    });

    it('GuildMemberAdd with cache returning None → RegisterMember called with invite_code: None', async () => {
      const { syncRpcCalls, dispatch } = await setupWithInviteCache(Option.none());

      await Effect.runPromise(
        dispatch(Discord.GatewayDispatchEvents.GuildMemberAdd, {
          guild_id: '999999999999999999',
          user: {
            id: '200000000000000002',
            username: 'new-member-2',
            bot: false,
            global_name: null,
            avatar: null,
          },
          roles: [],
          nick: null,
        }).pipe(Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None'))),
      );

      const registerCalls = syncRpcCalls.filter((c) => c.method === 'Guild/RegisterMember');
      expect(registerCalls).toHaveLength(1);
      const args = registerCalls[0].args as any;
      expect(Option.isNone(args.invite_code)).toBe(true);
    });
  });
});
