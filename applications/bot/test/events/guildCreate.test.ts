/**
 * TDD test for handleGuildCreate's empty-roles payload handling.
 *
 * Spec: .work-plans/discord-onboarding-fix-plan.md, PR-6 step 0.
 *
 * `guildCreate.ts` currently does:
 *   const roles = guild.roles ?? [];
 *   if (roles.length === 0) return Effect.void;
 * — a silent early return. A GUILD_CREATE dispatch that arrives without a `roles` payload (or with
 * an empty one) leaves `discord_guild_roles` stale forever, with no error and no log, which PR-9's
 * diagnostics and PR-7's reporting both read from. The fix (still bot-only, no RPC/wire change) is
 * to keep the early return (there is genuinely nothing to sync) but replace the silence with
 * `Effect.logWarning`, so the next occurrence in production is visible.
 *
 * This test pins the NEW behavior and is expected to FAIL against current code, which emits no log
 * at all on an empty roles payload.
 */

import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Logger } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleGuildCreate } from '~/events/guildCreate.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '111111111111111111';

// ---------------------------------------------------------------------------
// Log capture (mirrors handleRosterChannelCreated.test.ts / ensureMapping.test.ts)
// ---------------------------------------------------------------------------

const makeLogCapture = (): { messages: string[]; levels: string[]; layer: Layer.Layer<never> } => {
  const messages: string[] = [];
  const levels: string[] = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      messages.push(String(options.message));
      levels.push(String(options.logLevel));
    }),
  ]);
  return { messages, levels, layer };
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const makeRest = (): Layer.Layer<DiscordREST> =>
  Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        return () => Effect.succeed([]);
      },
    }),
  );

const makeSyncRpc = (): { calls: Record<string, unknown[][]>; layer: Layer.Layer<SyncRpc> } => {
  const calls: Record<string, unknown[][]> = {
    'Guild/RegisterGuild': [],
    'Guild/SyncGuildChannels': [],
    'Guild/SyncGuildRoles': [],
    'Guild/ReconcileMembers': [],
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        return (...args: unknown[]) => {
          if (!(prop in calls)) calls[prop] = [];
          calls[prop]?.push(args);
          return Effect.void;
        };
      },
    }),
  );

  return { calls, layer };
};

describe('handleGuildCreate — empty roles payload (PR-6 step 0)', () => {
  it('logs a warning instead of silently skipping when guild.roles is empty', async () => {
    const restLayer = makeRest();
    const { calls, layer: rpcLayer } = makeSyncRpc();
    const { messages, levels, layer: logLayer } = makeLogCapture();

    const payload = {
      id: GUILD_ID,
      name: 'Test Guild',
      features: [],
      roles: [],
    };

    await Effect.runPromise(
      handleGuildCreate(payload as any).pipe(
        Effect.provide(Layer.merge(rpcLayer, restLayer)),
        Effect.provide(logLayer),
      ),
    );

    // Nothing to sync — SyncGuildRoles must still not be called.
    expect(calls['Guild/SyncGuildRoles']).toHaveLength(0);

    // But the silence must be gone: a warning naming the guild must be logged.
    const warnCount = levels.filter((l) => l.toLowerCase().includes('warn')).length;
    expect(warnCount).toBeGreaterThan(0);
    expect(messages.join('\n')).toContain(GUILD_ID);
  });

  it('logs a warning when guild.roles is entirely absent from the payload (undefined)', async () => {
    const restLayer = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();
    const { levels, layer: logLayer } = makeLogCapture();

    const payload = {
      id: GUILD_ID,
      name: 'Test Guild',
      features: [],
      // roles omitted entirely — `guild.roles ?? []` covers this today with the same silent skip.
    };

    await Effect.runPromise(
      handleGuildCreate(payload as any).pipe(
        Effect.provide(Layer.merge(rpcLayer, restLayer)),
        Effect.provide(logLayer),
      ),
    );

    const warnCount = levels.filter((l) => l.toLowerCase().includes('warn')).length;
    expect(warnCount).toBeGreaterThan(0);
  });
});
