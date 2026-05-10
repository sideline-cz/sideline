// TDD mode — tests for GuildRoleCreate / GuildRoleUpdate / GuildRoleDelete handlers.
// Will FAIL until Phase 5 wires up the handlers in applications/bot/src/events/index.ts.
// Also tests GuildCreate → SyncGuildRoles call.

import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111';
const ROLE_ID = '999999999999999999';
const ROLE_ID_2 = '888888888888888888';

const makeRole = (overrides: Record<string, unknown> = {}) => ({
  id: ROLE_ID,
  name: 'Strikers',
  color: 0xff0000,
  position: 5,
  managed: false,
  mentionable: false,
  hoist: false,
  permissions: '0',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock RPC
// ---------------------------------------------------------------------------

type RpcCalls = {
  UpsertGuildRole: unknown[];
  DeleteGuildRole: unknown[];
  SyncGuildRoles: unknown[];
};

const makeRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = { UpsertGuildRole: [], DeleteGuildRole: [], SyncGuildRoles: [] };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Guild/UpsertGuildRole': (args: any) => {
      calls.UpsertGuildRole.push(args);
      return Effect.void;
    },
    'Guild/DeleteGuildRole': (args: any) => {
      calls.DeleteGuildRole.push(args);
      return Effect.void;
    },
    'Guild/SyncGuildRoles': (args: any) => {
      calls.SyncGuildRoles.push(args);
      return Effect.void;
    },
    // Other existing RPCs needed for guildCreate handler
    'Guild/RegisterGuild': () => Effect.void,
    'Guild/SyncGuildChannels': () => Effect.void,
    'Guild/ReconcileMembers': () => Effect.void,
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        // Tightened fallback: throw on unknown methods to surface typos in production code
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) throw new Error(`Unmocked RPC method: ${prop}`);
        return fn;
      },
    }),
  );
  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Handler invocation helpers
// ---------------------------------------------------------------------------

const invokeRoleCreate = async (
  payload: { guild_id: string; role: ReturnType<typeof makeRole> },
  rpcLayer: Layer.Layer<SyncRpc>,
) => {
  const { handleGuildRoleCreate } = await import('~/events/guildRoleCreate.js');
  return Effect.runPromise(handleGuildRoleCreate(payload as any).pipe(Effect.provide(rpcLayer)));
};

const invokeRoleUpdate = async (
  payload: { guild_id: string; role: ReturnType<typeof makeRole> },
  rpcLayer: Layer.Layer<SyncRpc>,
) => {
  const { handleGuildRoleUpdate } = await import('~/events/guildRoleUpdate.js');
  return Effect.runPromise(handleGuildRoleUpdate(payload as any).pipe(Effect.provide(rpcLayer)));
};

const invokeRoleDelete = async (
  payload: { guild_id: string; role_id: string },
  rpcLayer: Layer.Layer<SyncRpc>,
) => {
  const { handleGuildRoleDelete } = await import('~/events/guildRoleDelete.js');
  return Effect.runPromise(handleGuildRoleDelete(payload as any).pipe(Effect.provide(rpcLayer)));
};

const MockDiscordRESTLayer = Layer.succeed(
  DiscordREST,
  new Proxy({} as any, {
    get: (_: unknown, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      return () => Effect.succeed([]);
    },
  }),
);

const invokeGuildCreate = async (
  payload: {
    guild_id: string;
    id: string;
    name: string;
    features: string[];
    roles: ReturnType<typeof makeRole>[];
  },
  rpcLayer: Layer.Layer<SyncRpc>,
) => {
  const { handleGuildCreate } = await import('~/events/guildCreate.js');
  return Effect.runPromise(
    handleGuildCreate(payload as any).pipe(
      Effect.provide(Layer.merge(rpcLayer, MockDiscordRESTLayer)),
    ),
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuildRole event handlers', () => {
  it('GuildRoleCreate dispatch → UpsertGuildRole called with role fields', async () => {
    const { calls, layer: rpcLayer } = makeRpc();
    const role = makeRole();

    await invokeRoleCreate({ guild_id: GUILD_ID, role }, rpcLayer);

    expect(calls.UpsertGuildRole).toHaveLength(1);
    const call = calls.UpsertGuildRole[0] as any;
    expect(call.role_id).toBe(ROLE_ID);
    expect(call.name).toBe('Strikers');
    expect(call.color).toBe(0xff0000);
    expect(call.position).toBe(5);
    expect(call.managed).toBe(false);
  });

  it('GuildRoleUpdate dispatch → UpsertGuildRole called with updated fields', async () => {
    const { calls, layer: rpcLayer } = makeRpc();
    const updatedRole = makeRole({ name: 'Defenders', color: 0x0000ff, position: 3 });

    await invokeRoleUpdate({ guild_id: GUILD_ID, role: updatedRole }, rpcLayer);

    expect(calls.UpsertGuildRole).toHaveLength(1);
    const call = calls.UpsertGuildRole[0] as any;
    expect(call.name).toBe('Defenders');
    expect(call.color).toBe(0x0000ff);
    expect(call.position).toBe(3);
  });

  it('GuildRoleDelete dispatch → DeleteGuildRole called with {guild_id, role_id}', async () => {
    const { calls, layer: rpcLayer } = makeRpc();

    await invokeRoleDelete({ guild_id: GUILD_ID, role_id: ROLE_ID }, rpcLayer);

    expect(calls.DeleteGuildRole).toHaveLength(1);
    const call = calls.DeleteGuildRole[0] as any;
    expect(call.guild_id).toBe(GUILD_ID);
    expect(call.role_id).toBe(ROLE_ID);
  });

  it('GuildRoleUpdate handler swallows RPC errors so a single bad role does not crash the gateway', async () => {
    const { layer: rpcLayer } = makeRpc({
      'Guild/UpsertGuildRole': () => Effect.fail({ _tag: 'RpcClientError', message: 'DB down' }),
    });
    const role = makeRole();

    // Should NOT throw
    await expect(invokeRoleUpdate({ guild_id: GUILD_ID, role }, rpcLayer)).resolves.not.toThrow();
  });

  it('GuildCreate dispatch → SyncGuildRoles called once with the guild role list', async () => {
    // Plan §5: guildCreate handler calls Guild/SyncGuildRoles alongside SyncGuildChannels
    const { calls, layer: rpcLayer } = makeRpc();
    const roleA = makeRole({ id: ROLE_ID, name: 'Strikers' });
    const roleB = makeRole({ id: ROLE_ID_2, name: 'Defenders', position: 3 });

    await invokeGuildCreate(
      {
        guild_id: GUILD_ID,
        id: GUILD_ID,
        name: 'Test Guild',
        features: [],
        roles: [roleA, roleB],
      },
      rpcLayer,
    );

    expect(calls.SyncGuildRoles).toHaveLength(1);
    const syncCall = calls.SyncGuildRoles[0] as any;
    // Called with the full role list from the GuildCreate payload
    expect(syncCall.roles).toHaveLength(2);
    const roleIds = (syncCall.roles as any[]).map((r: any) => r.role_id);
    expect(roleIds).toContain(ROLE_ID);
    expect(roleIds).toContain(ROLE_ID_2);
  });
});
