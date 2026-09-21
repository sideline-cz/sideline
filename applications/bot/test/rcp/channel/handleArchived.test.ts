/**
 * TDD (fix/archived-ancestor-walk, T4) — regression tests for `handleGroupArchived`
 * (`~/rcp/channel/handleArchived.ts`).
 *
 * `handleGroupArchived` moves the group's Discord channel to the archive category and deletes
 * the channel's permission overwrite for the group's role, but — unlike its sibling
 * `handleRosterArchived` (same file, ~:82) — never calls `deleteRole`. Archiving a group in
 * Sideline is meant to make it behave as deleted; leaving the Discord role behind means a
 * captain sees a stale, unmanaged role forever, and (per this PR's other fixes) a future
 * `member_added` emitted for that same archived group would otherwise recreate the role via the
 * bot's `handleMemberAdded.ts` `createRoleOnly` fallback.
 *
 * Mock pattern copied from the closest sibling handler test,
 * `applications/bot/test/handleDiscordArchived.test.ts` (Proxy-based `DiscordREST` mock, no
 * dependency-injection framework).
 */

import type { Discord, GroupModel, RosterModel, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999998' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0009-000000000010' as Team.TeamId;
const GROUP_ID = '00000000-0000-0000-0009-000000000020' as GroupModel.GroupId;
const ROSTER_ID = '00000000-0000-0000-0009-000000000030' as RosterModel.RosterId;
const DISCORD_CHANNEL_ID = '111111111111111112' as Discord.Snowflake;
const DISCORD_ROLE_ID = '222222222222222223' as Discord.Snowflake;
const ARCHIVE_CATEGORY_ID = '333333333333333334' as Discord.Snowflake;
const EVENT_ID = 'evt-00000000-0000-0000-0009-000000000001' as any;

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type RestCalls = {
  updateChannel: unknown[];
  deleteChannel: unknown[];
  deleteChannelPermissionOverwrite: unknown[];
  deleteGuildRole: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    updateChannel: [],
    deleteChannel: [],
    deleteChannelPermissionOverwrite: [],
    deleteGuildRole: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    updateChannel: (...args: any[]) => {
      calls.updateChannel.push(args);
      return Effect.succeed({});
    },
    deleteChannel: (...args: any[]) => {
      calls.deleteChannel.push(args);
      return Effect.void;
    },
    deleteChannelPermissionOverwrite: (...args: any[]) => {
      calls.deleteChannelPermissionOverwrite.push(args);
      return Effect.void;
    },
    deleteGuildRole: (...args: any[]) => {
      calls.deleteGuildRole.push(args);
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

type RpcCalls = {
  DeleteRosterMapping: unknown[];
  UpdateRosterChannel: unknown[];
};

const makeRpc = (): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = {
    DeleteRosterMapping: [],
    UpdateRosterChannel: [],
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        if (prop === 'Channel/DeleteRosterMapping') {
          return (args: any) => {
            calls.DeleteRosterMapping.push(args);
            return Effect.void;
          };
        }
        if (prop === 'Channel/UpdateRosterChannel') {
          return (args: any) => {
            calls.UpdateRosterChannel.push(args);
            return Effect.void;
          };
        }
        return () => Effect.void;
      },
    }),
  );

  return { calls, layer };
};

const run = (effect: Effect.Effect<void, unknown, any>, layers: Layer.Layer<any>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// handleGroupArchived
// ---------------------------------------------------------------------------

describe('handleGroupArchived', () => {
  it('moves the channel, deletes the permission overwrite, AND deletes the Discord role', async () => {
    const { handleGroupArchived } = await import('~/rcp/channel/handleArchived.js');
    const { calls: restCalls, layer: restLayer } = makeRest();

    const event = new (await import('@sideline/domain')).ChannelRpcEvents.GroupChannelArchivedEvent(
      {
        id: EVENT_ID,
        team_id: TEAM_ID,
        guild_id: GUILD_ID,
        group_id: GROUP_ID,
        discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
        discord_role_id: Option.some(DISCORD_ROLE_ID),
        archive_category_id: ARCHIVE_CATEGORY_ID,
      },
    );

    await run(handleGroupArchived(event), restLayer);

    // Existing behavior — must keep working.
    expect(restCalls.updateChannel).toHaveLength(1);
    expect(restCalls.deleteChannelPermissionOverwrite).toHaveLength(1);

    // The regression this test pins: `handleGroupArchived` must delete the Discord role too,
    // exactly like its sibling `handleRosterArchived` does — currently it does not, so this
    // fails red until the fix lands.
    expect(restCalls.deleteGuildRole).toHaveLength(1);
    const deleteRoleArgs = restCalls.deleteGuildRole[0] as any[];
    expect(deleteRoleArgs[0]).toBe(GUILD_ID);
    expect(deleteRoleArgs[1]).toBe(DISCORD_ROLE_ID);
  });
});

// ---------------------------------------------------------------------------
// handleGroupArchived — edge cases surfaced by adversarial review (see AGENTS.md /
// architect spec for this branch): `deleteRole` was moved from inside the `onSome` branch
// of `Option.match(event.discord_channel_id)` to a top-level `Effect.tap`, and `deleteRole` /
// `deletePermissionOverwrite` gained `Effect.catchIf(isDiscordNotFoundError, () => Effect.void)`
// INSIDE their `Effect.retry(retryPolicy)`. None of this was reachable by the single happy-path
// test above.
// ---------------------------------------------------------------------------

describe('handleGroupArchived — edge cases', () => {
  it('role-only mapping (discord_channel_id None, discord_role_id Some) still deletes the Discord role', async () => {
    const { handleGroupArchived } = await import('~/rcp/channel/handleArchived.js');
    const { calls: restCalls, layer: restLayer } = makeRest();

    const event = new (await import('@sideline/domain')).ChannelRpcEvents.GroupChannelArchivedEvent(
      {
        id: EVENT_ID,
        team_id: TEAM_ID,
        guild_id: GUILD_ID,
        group_id: GROUP_ID,
        discord_channel_id: Option.none(),
        discord_role_id: Option.some(DISCORD_ROLE_ID),
        archive_category_id: ARCHIVE_CATEGORY_ID,
      },
    );

    await run(handleGroupArchived(event), restLayer);

    // No channel → no channel-related REST calls.
    expect(restCalls.updateChannel).toHaveLength(0);
    expect(restCalls.deleteChannel).toHaveLength(0);
    expect(restCalls.deleteChannelPermissionOverwrite).toHaveLength(0);

    // The role must still be deleted — the top-level `deleteRole` tap outside the
    // `Option.match(discord_channel_id)`. Fails red if `deleteRole` moves back inside `onSome`.
    expect(restCalls.deleteGuildRole).toHaveLength(1);
    const deleteRoleArgs = restCalls.deleteGuildRole[0] as any[];
    expect(deleteRoleArgs[0]).toBe(GUILD_ID);
    expect(deleteRoleArgs[1]).toBe(DISCORD_ROLE_ID);
  });

  it('updateChannel (move-to-archive) fails → falls back to deleteChannel AND deleteGuildRole, and the handler still succeeds', async () => {
    const { handleGroupArchived } = await import('~/rcp/channel/handleArchived.js');
    // The handler retries `updateChannel` via `retryPolicy` (exponential 1s × 3, ~7s) before
    // falling back, so this test needs a generous timeout.
    const updateAttempts: unknown[][] = [];
    const { calls: restCalls, layer: restLayer } = makeRest({
      updateChannel: (...args: any[]) => {
        updateAttempts.push(args);
        return Effect.fail({ response: { status: 500 }, message: 'Internal Server Error' });
      },
    });

    const event = new (await import('@sideline/domain')).ChannelRpcEvents.GroupChannelArchivedEvent(
      {
        id: EVENT_ID,
        team_id: TEAM_ID,
        guild_id: GUILD_ID,
        group_id: GROUP_ID,
        discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
        discord_role_id: Option.some(DISCORD_ROLE_ID),
        archive_category_id: ARCHIVE_CATEGORY_ID,
      },
    );

    // Must not throw — the fallback has to fully clean up and report success. If it fails the
    // effect instead, `ProcessorService` marks the event permanently failed.
    await run(handleGroupArchived(event), restLayer);

    expect(updateAttempts.length).toBeGreaterThanOrEqual(1);
    expect(restCalls.deleteChannel).toHaveLength(1);
    expect(restCalls.deleteChannel[0]).toEqual([DISCORD_CHANNEL_ID]);
    expect(restCalls.deleteGuildRole.length).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('updateChannel fails AND the role is already gone (404 Unknown Role) → deleteChannel still runs and the handler still succeeds', async () => {
    const { handleGroupArchived } = await import('~/rcp/channel/handleArchived.js');
    const updateAttempts: unknown[][] = [];
    const roleAttempts: unknown[][] = [];
    const { calls: restCalls, layer: restLayer } = makeRest({
      updateChannel: (...args: any[]) => {
        updateAttempts.push(args);
        return Effect.fail({ response: { status: 500 } });
      },
      deleteGuildRole: (...args: any[]) => {
        roleAttempts.push(args);
        // Shaped per `discordErrors.test.ts` — code 10011 (Unknown Role) alone, no
        // `response.status`, is what `isDiscordNotFoundError` recognises.
        return Effect.fail({ data: { code: 10011 } });
      },
    });

    const event = new (await import('@sideline/domain')).ChannelRpcEvents.GroupChannelArchivedEvent(
      {
        id: EVENT_ID,
        team_id: TEAM_ID,
        guild_id: GUILD_ID,
        group_id: GROUP_ID,
        discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
        discord_role_id: Option.some(DISCORD_ROLE_ID),
        archive_category_id: ARCHIVE_CATEGORY_ID,
      },
    );

    // Regression pin: without `catchIf(isDiscordNotFoundError, …)` inside `deleteRole`'s
    // retry, a stale role id fails `deleteRole`, which runs BEFORE `deleteChannel` inside
    // `deleteChannelAndRole` — so the channel is never deleted and the move-to-archive
    // fallback's one job is defeated.
    await run(handleGroupArchived(event), restLayer);

    expect(roleAttempts.length).toBeGreaterThanOrEqual(1);
    expect(restCalls.deleteChannel).toHaveLength(1);
    expect(restCalls.deleteChannel[0]).toEqual([DISCORD_CHANNEL_ID]);
  }, 20_000);

  it('idempotent redelivery — role and channel are both already gone (404) → the handler still succeeds', async () => {
    const { handleGroupArchived } = await import('~/rcp/channel/handleArchived.js');
    const notFound = { response: { status: 404 } };
    const updateAttempts: unknown[][] = [];
    const { calls: restCalls, layer: restLayer } = makeRest({
      updateChannel: (...args: any[]) => {
        updateAttempts.push(args);
        return Effect.fail(notFound);
      },
      deleteChannel: (...args: any[]) => {
        restCalls.deleteChannel.push(args);
        return Effect.fail(notFound);
      },
      deleteChannelPermissionOverwrite: (...args: any[]) => {
        restCalls.deleteChannelPermissionOverwrite.push(args);
        return Effect.fail(notFound);
      },
      deleteGuildRole: (...args: any[]) => {
        restCalls.deleteGuildRole.push(args);
        return Effect.fail(notFound);
      },
    });

    const event = new (await import('@sideline/domain')).ChannelRpcEvents.GroupChannelArchivedEvent(
      {
        id: EVENT_ID,
        team_id: TEAM_ID,
        guild_id: GUILD_ID,
        group_id: GROUP_ID,
        discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
        discord_role_id: Option.some(DISCORD_ROLE_ID),
        archive_category_id: ARCHIVE_CATEGORY_ID,
      },
    );

    await run(handleGroupArchived(event), restLayer);

    expect(updateAttempts.length).toBeGreaterThanOrEqual(1);
    expect(restCalls.deleteChannel.length).toBeGreaterThanOrEqual(1);
    expect(restCalls.deleteGuildRole.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// handleRosterArchived — POSITIVE CONTROL: proves the mock harness and `deleteGuildRole`
// assertion shape are correct by pinning the sibling handler that ALREADY deletes the role.
// If this test failed, the `handleGroupArchived` regression test above would be meaningless —
// it would be impossible to tell whether a red result meant "the bug exists" or "the mock is
// wired wrong".
// ---------------------------------------------------------------------------

describe('handleRosterArchived (positive control — already deletes the role today)', () => {
  it('moves the channel, deletes the permission overwrite, AND deletes the Discord role', async () => {
    const { handleRosterArchived } = await import('~/rcp/channel/handleArchived.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.RosterChannelArchivedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      roster_id: ROSTER_ID,
      discord_channel_id: DISCORD_CHANNEL_ID,
      discord_role_id: Option.some(DISCORD_ROLE_ID),
      archive_category_id: ARCHIVE_CATEGORY_ID,
    });

    await run(handleRosterArchived(event), Layer.merge(rpcLayer, restLayer));

    expect(restCalls.updateChannel).toHaveLength(1);
    expect(restCalls.deleteChannelPermissionOverwrite).toHaveLength(1);
    expect(restCalls.deleteGuildRole).toHaveLength(1);
    const deleteRoleArgs = restCalls.deleteGuildRole[0] as any[];
    expect(deleteRoleArgs[0]).toBe(GUILD_ID);
    expect(deleteRoleArgs[1]).toBe(DISCORD_ROLE_ID);
  });
});
