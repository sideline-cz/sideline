/**
 * Regression tests for blocker 2: an adopted mapping's underlying Discord role must never be
 * deleted — only the mapping row. A bot-created (non-adopted) mapping keeps the previous
 * behaviour (delete both the Discord role and the mapping).
 */

import { type Discord, type Role, RoleRpcEvents, type Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleDeleted } from '~/rcp/role/handleDeleted.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000030' as Team.TeamId;
const ROLE_ID = '00000000-0000-0000-0000-000000000031' as Role.RoleId;
const DISCORD_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const EVENT_ID = '00000000-0000-0000-0000-000000000033';

const makeEvent = () =>
  new RoleRpcEvents.RoleDeletedEvent({
    id: EVENT_ID as any,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    role_id: ROLE_ID,
  });

type AnyFn = (...args: any[]) => Effect.Effect<any, any, any>;

const makeRest = (
  overrides: Partial<Record<string, AnyFn>> = {},
): { calls: Record<string, unknown[][]>; layer: Layer.Layer<DiscordREST> } => {
  const calls: Record<string, unknown[][]> = { deleteGuildRole: [] };

  const defaults: Record<string, AnyFn> = {
    deleteGuildRole: (...args: unknown[]) => {
      calls.deleteGuildRole?.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (fn !== undefined) return fn;
        return (...args: unknown[]) => {
          throw new Error(`Unexpected DiscordREST.${prop} call: ${JSON.stringify(args)}`);
        };
      },
    }),
  );

  return { calls, layer };
};

const makeSyncRpc = (
  adopted: boolean,
  overrides: Partial<Record<string, AnyFn>> = {},
): { calls: Record<string, unknown[][]>; layer: Layer.Layer<SyncRpc> } => {
  const calls: Record<string, unknown[][]> = {
    'Role/GetMapping': [],
    'Role/DeleteMapping': [],
  };

  const defaults: Record<string, AnyFn> = {
    'Role/GetMapping': (...args: unknown[]) => {
      calls['Role/GetMapping']?.push(args);
      return Effect.succeed(
        Option.some({
          id: '00000000-0000-0000-0000-000000000099',
          team_id: TEAM_ID,
          role_id: ROLE_ID,
          discord_role_id: DISCORD_ROLE_ID,
          adopted,
        }),
      );
    },
    'Role/DeleteMapping': (...args: unknown[]) => {
      calls['Role/DeleteMapping']?.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (fn !== undefined) return fn;
        return (...args: unknown[]) => {
          throw new Error(`Unexpected SyncRpc.${prop} call: ${JSON.stringify(args)}`);
        };
      },
    }),
  );

  return { calls, layer };
};

const run = (
  effect: Effect.Effect<void, unknown, DiscordREST | SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(restLayer, rpcLayer))));

describe('handleDeleted', () => {
  it('BLOCKER 2 regression: never deletes the underlying Discord role for an adopted mapping', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc(true);

    await run(handleDeleted(makeEvent()), restLayer, rpcLayer);

    expect(restCalls.deleteGuildRole).toHaveLength(0);
    expect(rpcCalls['Role/DeleteMapping']).toHaveLength(1);
    expect(rpcCalls['Role/DeleteMapping']?.[0]).toMatchObject([
      { team_id: TEAM_ID, role_id: ROLE_ID },
    ]);
  });

  it('deletes both the Discord role and the mapping for a bot-created (non-adopted) mapping', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc(false);

    await run(handleDeleted(makeEvent()), restLayer, rpcLayer);

    expect(restCalls.deleteGuildRole).toHaveLength(1);
    expect(restCalls.deleteGuildRole?.[0]).toMatchObject([GUILD_ID, DISCORD_ROLE_ID]);
    expect(rpcCalls['Role/DeleteMapping']).toHaveLength(1);
  });
});
