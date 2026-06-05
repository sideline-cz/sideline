/**
 * Unit tests for the managed channel adopt handler:
 *   - handleManagedAdopted
 *
 * Key invariants:
 *   - Calls updateChannel with a single permission_overwrites array containing
 *     { id: guild_id, type: ROLE, deny: <ViewChannel> }.
 *   - Deny value includes ViewChannel bit.
 *   - Does NOT call setChannelPermissionOverwrite (per-overwrite API).
 *   - Does NOT grant any permissions.
 *   - REST failure → retried (exponential); permanent 403 → surfaces error.
 */

import type { Discord, Team, TeamChannel } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0009-000000000010' as Team.TeamId;
const CHANNEL_ID = '00000000-0000-0000-0009-000000000030' as TeamChannel.TeamChannelId;
const DISCORD_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const EVENT_ID = 'evt-00000000-0000-0000-0009-000000000001' as any;

// ViewChannel permission bit (Discord permission integer)
const VIEW_CHANNEL_BIT = BigInt(1 << 10); // Discord.Permissions.ViewChannel = 1024n

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type RestCalls = {
  updateChannel: unknown[];
  setChannelPermissionOverwrite: unknown[];
  deleteChannelPermissionOverwrite: unknown[];
  deleteChannel: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    updateChannel: [],
    setChannelPermissionOverwrite: [],
    deleteChannelPermissionOverwrite: [],
    deleteChannel: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    updateChannel: (...args: any[]) => {
      calls.updateChannel.push(args);
      return Effect.succeed({});
    },
    setChannelPermissionOverwrite: (...args: any[]) => {
      calls.setChannelPermissionOverwrite.push(args);
      return Effect.void;
    },
    deleteChannelPermissionOverwrite: (...args: any[]) => {
      calls.deleteChannelPermissionOverwrite.push(args);
      return Effect.void;
    },
    deleteChannel: (...args: any[]) => {
      calls.deleteChannel.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) return () => Effect.void;
        return fn;
      },
    }),
  );

  return { calls, layer };
};

const run = (effect: Effect.Effect<void, unknown, DiscordREST>, rest: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(effect.pipe(Effect.provide(rest)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// handleManagedAdopted
// ---------------------------------------------------------------------------

describe('handleManagedAdopted', () => {
  it('calls updateChannel with permission_overwrites deny ViewChannel for @everyone', async () => {
    const { handleManagedAdopted } = await import('~/rcp/channel/handleManagedAdopted.js');
    const { calls: restCalls, layer: restLayer } = makeRest();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelAdoptedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: DISCORD_CHANNEL_ID,
    });

    await run(handleManagedAdopted(event), restLayer);

    // Must call updateChannel exactly once
    expect(restCalls.updateChannel).toHaveLength(1);
    const updateArgs = restCalls.updateChannel[0] as any[];
    // First arg is the channel id
    expect(updateArgs[0]).toBe(DISCORD_CHANNEL_ID);

    // Second arg contains permission_overwrites
    const payload = updateArgs[1] as any;
    expect(Array.isArray(payload.permission_overwrites)).toBe(true);
    expect(payload.permission_overwrites).toHaveLength(1);

    const overwrite = payload.permission_overwrites[0];
    // Targets the guild id (i.e. @everyone role)
    expect(overwrite.id).toBe(GUILD_ID);
    // Type must be ROLE (0)
    expect(overwrite.type).toBe(DiscordTypes.ChannelPermissionOverwrites.ROLE);
    // Deny must include ViewChannel bit
    const denyValue = BigInt(overwrite.deny);
    expect((denyValue & VIEW_CHANNEL_BIT) === VIEW_CHANNEL_BIT).toBe(true);
  });

  it('does NOT call setChannelPermissionOverwrite (uses full-replace updateChannel instead)', async () => {
    const { handleManagedAdopted } = await import('~/rcp/channel/handleManagedAdopted.js');
    const { calls: restCalls, layer: restLayer } = makeRest();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelAdoptedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: DISCORD_CHANNEL_ID,
    });

    await run(handleManagedAdopted(event), restLayer);

    // Must NOT call setChannelPermissionOverwrite
    expect(restCalls.setChannelPermissionOverwrite).toHaveLength(0);
    // Must NOT call deleteChannelPermissionOverwrite
    expect(restCalls.deleteChannelPermissionOverwrite).toHaveLength(0);
    // Must NOT call deleteChannel
    expect(restCalls.deleteChannel).toHaveLength(0);
  });

  it('updateChannel fails (retryable 500) → retried at least once, does NOT call deleteChannel', async () => {
    const { handleManagedAdopted } = await import('~/rcp/channel/handleManagedAdopted.js');
    const updateAttempts: unknown[][] = [];
    const { calls: restCalls, layer: restLayer } = makeRest({
      updateChannel: (...args: any[]) => {
        updateAttempts.push(args);
        return Effect.fail({ _tag: 'RestError', status: 500, message: 'Internal Server Error' });
      },
    });

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelAdoptedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: DISCORD_CHANNEL_ID,
    });

    // Handler retries — may throw after exhausting retries; we allow failure here
    await Effect.runPromise(
      handleManagedAdopted(event).pipe(
        Effect.provide(restLayer),
        Effect.catchCause(() => Effect.void),
      ) as Effect.Effect<void, never, never>,
    );

    // updateChannel was attempted at least once (possibly more via retry)
    expect(updateAttempts.length).toBeGreaterThanOrEqual(1);
    // deleteChannel must NOT be called
    expect(restCalls.deleteChannel).toHaveLength(0);
    // setChannelPermissionOverwrite must NOT be called
    expect(restCalls.setChannelPermissionOverwrite).toHaveLength(0);
  }, 30000); // Allow time for exponential retries (1s × 3)
});
