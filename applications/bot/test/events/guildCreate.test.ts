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
import { handleGuildCreate, MEMBER_PAGE_CAP, MEMBER_PAGE_LIMIT } from '~/events/guildCreate.js';
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

// ---------------------------------------------------------------------------
// PR-8 (CC-10 S6) — member-list pagination
// ---------------------------------------------------------------------------

const makeRawMember = (id: string) => ({
  user: { id, username: `user-${id}`, avatar: null, global_name: null, bot: false },
  roles: [] as string[],
  nick: null,
});

const makePage = (startId: number, count: number) =>
  Array.from({ length: count }, (_, i) => makeRawMember(String(startId + i)));

const makePaginatedRest = (
  pages: ReadonlyArray<ReadonlyArray<ReturnType<typeof makeRawMember>>>,
): { calls: Array<{ after: number | undefined }>; layer: Layer.Layer<DiscordREST> } => {
  const calls: Array<{ after: number | undefined }> = [];
  let callIndex = 0;
  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        if (prop === 'listGuildMembers') {
          return (_guildId: string, options?: { limit?: number; after?: number }) => {
            calls.push({ after: options?.after });
            const page = pages[callIndex] ?? [];
            callIndex++;
            return Effect.succeed(page);
          };
        }
        return () => Effect.succeed([]);
      },
    }),
  );
  return { calls, layer };
};

const guildCreatePayload = () => ({
  id: GUILD_ID,
  name: 'Test Guild',
  features: [],
  roles: [{ id: '1', name: 'everyone', color: 0, position: 0, managed: false }],
});

describe('handleGuildCreate — member-list pagination (PR-8 CC-10 S6)', () => {
  it('paginates listGuildMembers with an after cursor until a short page', async () => {
    const page1 = makePage(1, MEMBER_PAGE_LIMIT);
    const page2 = makePage(1001, MEMBER_PAGE_LIMIT);
    const page3 = makePage(2001, 500);
    const { calls, layer: restLayer } = makePaginatedRest([page1, page2, page3]);
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    await Effect.runPromise(
      handleGuildCreate(guildCreatePayload() as any).pipe(
        Effect.provide(Layer.merge(rpcLayer, restLayer)),
      ),
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]?.after).toBeUndefined();
    // `after` is the previous page's LAST raw member id, passed through as the snowflake
    // STRING. dfx types the param `number`, but a real snowflake (~1.4e18) exceeds
    // Number.MAX_SAFE_INTEGER (~9.0e15), so converting would truncate the cursor and — since
    // IEEE754 rounds to nearest — could round it up and skip members entirely. See the note in
    // guildCreate.ts. Asserting the string is asserting the cursor is not corrupted.
    expect(calls[1]?.after).toBe('1000');
    expect(calls[2]?.after).toBe('2000');

    const reconcileCall = rpcCalls['Guild/ReconcileMembers']?.[0]?.[0] as {
      members: ReadonlyArray<unknown>;
      complete: boolean;
    };
    expect(reconcileCall.members).toHaveLength(MEMBER_PAGE_LIMIT * 2 + 500);
    expect(reconcileCall.complete).toBe(true);
  });

  it('sets complete: true when the last page is short', async () => {
    const { layer: restLayer } = makePaginatedRest([makePage(1, 10)]);
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    await Effect.runPromise(
      handleGuildCreate(guildCreatePayload() as any).pipe(
        Effect.provide(Layer.merge(rpcLayer, restLayer)),
      ),
    );

    const reconcileCall = rpcCalls['Guild/ReconcileMembers']?.[0]?.[0] as { complete: boolean };
    expect(reconcileCall.complete).toBe(true);
  });

  it('sets complete: false when the page cap is hit', async () => {
    const pages = Array.from({ length: MEMBER_PAGE_CAP }, (_, i) =>
      makePage(i * MEMBER_PAGE_LIMIT + 1, MEMBER_PAGE_LIMIT),
    );
    const { calls, layer: restLayer } = makePaginatedRest(pages);
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    await Effect.runPromise(
      handleGuildCreate(guildCreatePayload() as any).pipe(
        Effect.provide(Layer.merge(rpcLayer, restLayer)),
      ),
    );

    // Every page returned a full MEMBER_PAGE_LIMIT rows, so the cap — not a short page — is what
    // stopped the loop: exactly MEMBER_PAGE_CAP requests, never an 11th.
    expect(calls).toHaveLength(MEMBER_PAGE_CAP);
    const reconcileCall = rpcCalls['Guild/ReconcileMembers']?.[0]?.[0] as {
      members: ReadonlyArray<unknown>;
      complete: boolean;
    };
    expect(reconcileCall.members).toHaveLength(MEMBER_PAGE_LIMIT * MEMBER_PAGE_CAP);
    expect(reconcileCall.complete).toBe(false);
  });
});
