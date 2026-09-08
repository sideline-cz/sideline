/**
 * TDD tests for ensureMapping — the three-tier role-mapping resolution:
 *   1. Role/GetMapping → Some → use it (unchanged)
 *   2. adopt: listGuildRoles + getMyUser + getGuildMember → pickAdoptableRole → Some → Role/UpsertMapping
 *   3. None, or any failure in tier 2 → createGuildRole (unchanged, always safe)
 *
 * These tests describe NEW behavior after PR-6 lands and are expected to FAIL until
 * applications/bot/src/rest/roles/ensureMapping.ts is rewritten to read candidates from
 * DiscordREST (`listGuildRoles`, `getMyUser`, `getGuildMember`) via `pickAdoptableRole`.
 *
 * Spec: .work-plans/discord-onboarding-fix-plan.md, PR-6 step 2, tests 8-14. Decision CC-7.
 *
 * Pattern: mirrors applications/bot/test/rcp/roleProvision/handleProvisionRole.test.ts and
 * applications/bot/test/rcp/channel/handleRosterChannelCreated.test.ts (Layer.succeed recorders
 * for DiscordREST and SyncRpc; Logger.layer capture for the near-miss warning).
 */

import type { Discord, Role, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Logger, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ensureMapping } from '~/rest/roles/ensureMapping.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000030' as Team.TeamId;
const ROLE_ID = '00000000-0000-0000-0000-000000000031' as Role.RoleId;
const ROLE_NAME = 'Captain';

const BOT_OWN_ROLE_ID = '333333333333333333';
/** Distinct from the role id — the old mock conflated the two. */
const BOT_USER_ID = '444444444444444444';
const BOT_TOP_POSITION = 10;

const EXISTING_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const NEW_ROLE_ID = '999999999999999999' as Discord.Snowflake;

const CACHED_MAPPING_ID = '00000000-0000-0000-0000-000000000099';

// ---------------------------------------------------------------------------
// Guild role factory (dfx GuildRoleResponse — only the fields ensureMapping needs)
// ---------------------------------------------------------------------------

const makeGuildRole = (overrides: Record<string, unknown> = {}) => ({
  id: '100000000000000001',
  name: ROLE_NAME,
  description: null,
  permissions: '0',
  position: 1,
  color: 0,
  colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
  hoist: false,
  managed: false,
  mentionable: false,
  icon: null,
  unicode_emoji: null,
  flags: 0,
  ...overrides,
});

/** The bot's own role, present in listGuildRoles and referenced by getGuildMember().roles. */
const botOwnRole = makeGuildRole({
  id: BOT_OWN_ROLE_ID,
  name: '@sideline-bot',
  managed: true,
  position: BOT_TOP_POSITION,
});

// ---------------------------------------------------------------------------
// Log capture (mirrors handleRosterChannelCreated.test.ts)
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
// DiscordREST mock
// ---------------------------------------------------------------------------

type RestCallRecord = {
  listGuildRoles: unknown[][];
  getMyUser: unknown[][];
  getGuildMember: unknown[][];
  /** Kept only so a test can assert this user-OAuth endpoint is never called. */
  getMyGuildMember: unknown[][];
  createGuildRole: unknown[][];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = {
    listGuildRoles: [],
    getMyUser: [],
    getGuildMember: [],
    getMyGuildMember: [],
    createGuildRole: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    listGuildRoles: (...args: any[]) => {
      calls.listGuildRoles.push(args);
      return Effect.succeed([botOwnRole, makeGuildRole({ id: EXISTING_ROLE_ID, position: 3 })]);
    },
    getMyUser: (...args: any[]) => {
      calls.getMyUser.push(args);
      return Effect.succeed({ id: BOT_USER_ID, username: 'sideline-bot' });
    },
    // `GET /users/@me/guilds/{id}/member` — user-OAuth only. A bot token gets
    // 20001 every time, which is what shipped. Mocking it as if it worked is
    // why the suite stayed green while adoption failed 100% in production, so
    // the default now reproduces Discord's actual answer.
    getMyGuildMember: (...args: any[]) => {
      calls.getMyGuildMember.push(args);
      return Effect.fail(
        new Error('DiscordRestError: {"message":"Bots cannot use this endpoint","code":20001}'),
      );
    },
    getGuildMember: (...args: any[]) => {
      calls.getGuildMember.push(args);
      return Effect.succeed({
        avatar: null,
        banner: null,
        communication_disabled_until: null,
        flags: 0,
        joined_at: '2024-01-01T00:00:00.000Z',
        nick: null,
        pending: false,
        premium_since: null,
        roles: [BOT_OWN_ROLE_ID],
        user: { id: BOT_USER_ID, username: 'sideline-bot' },
        mute: false,
        deaf: false,
      });
    },
    createGuildRole: (...args: any[]) => {
      calls.createGuildRole.push(args);
      return Effect.succeed({ id: NEW_ROLE_ID, name: args[1]?.name ?? '' });
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

// ---------------------------------------------------------------------------
// SyncRpc mock
// ---------------------------------------------------------------------------

const makeSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: Record<string, unknown[][]>; layer: Layer.Layer<SyncRpc> } => {
  const calls: Record<string, unknown[][]> = {
    'Role/GetMapping': [],
    'Role/UpsertMapping': [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Role/GetMapping': (...args: any[]) => {
      calls['Role/GetMapping']?.push(args);
      return Effect.succeed(Option.none());
    },
    'Role/UpsertMapping': (...args: any[]) => {
      calls['Role/UpsertMapping']?.push(args);
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

// ---------------------------------------------------------------------------
// Invocation helper
// ---------------------------------------------------------------------------

const runEnsureMapping = (
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
  extraLayer?: Layer.Layer<never>,
) => {
  const base = ensureMapping(TEAM_ID, ROLE_ID, GUILD_ID, ROLE_NAME).pipe(
    Effect.provide(Layer.merge(rpcLayer, restLayer)),
  );
  return Effect.runPromise(extraLayer ? base.pipe(Effect.provide(extraLayer)) : base);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureMapping', () => {
  it('#8 returns the cached mapping without any Discord call', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc({
      'Role/GetMapping': (...args: any[]) => {
        rpcCalls['Role/GetMapping']?.push(args);
        return Effect.succeed(
          Option.some({
            id: CACHED_MAPPING_ID,
            team_id: TEAM_ID,
            role_id: ROLE_ID,
            discord_role_id: EXISTING_ROLE_ID,
          }),
        );
      },
    });

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(result).toBe(EXISTING_ROLE_ID);
    expect(restCalls.listGuildRoles).toHaveLength(0);
    expect(restCalls.getGuildMember).toHaveLength(0);
    expect(restCalls.createGuildRole).toHaveLength(0);
  });

  it('#9 reuses an existing guild role with the same name instead of creating one', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(result).toBe(EXISTING_ROLE_ID);
    expect(restCalls.createGuildRole).toHaveLength(0);
    const upsertCalls = rpcCalls['Role/UpsertMapping'];
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls?.[0]).toMatchObject([
      expect.objectContaining({
        team_id: TEAM_ID,
        role_id: ROLE_ID,
        discord_role_id: EXISTING_ROLE_ID,
        // Blocker 2 (provenance): adoption must record `adopted: true` so `handleDeleted` never
        // deletes a Discord role Sideline did not create.
        adopted: true,
      }),
    ]);
  });

  it('#10 creates a role when no name matches', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildRoles: (...args: any[]) => {
        restCalls.listGuildRoles.push(args);
        return Effect.succeed([
          botOwnRole,
          makeGuildRole({ id: '444444444444444444', name: 'Not Captain', position: 3 }),
        ]);
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(result).toBe(NEW_ROLE_ID);
    expect(restCalls.createGuildRole).toHaveLength(1);
    expect(restCalls.createGuildRole[0]?.[1]).toMatchObject({ permissions: 0 });
    const upsertCalls = rpcCalls['Role/UpsertMapping'];
    expect(upsertCalls?.[0]).toMatchObject([
      expect.objectContaining({ discord_role_id: NEW_ROLE_ID, adopted: false }),
    ]);
  });

  it('#11 creates a role rather than adopting an ADMINISTRATOR role of the same name', async () => {
    // End-to-end form of adoptableGuildRole test 2 (blocker 5(a)'s regression test).
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildRoles: (...args: any[]) => {
        restCalls.listGuildRoles.push(args);
        return Effect.succeed([
          botOwnRole,
          makeGuildRole({ id: EXISTING_ROLE_ID, name: ROLE_NAME, permissions: '8', position: 3 }),
        ]);
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(result).toBe(NEW_ROLE_ID);
    expect(restCalls.createGuildRole).toHaveLength(1);
    const upsertCalls = rpcCalls['Role/UpsertMapping'];
    expect(upsertCalls?.[0]).toMatchObject([
      expect.objectContaining({ discord_role_id: NEW_ROLE_ID, adopted: false }),
    ]);
  });

  it('#12 falls back to createGuildRole when listGuildRoles fails', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildRoles: (...args: any[]) => {
        restCalls.listGuildRoles.push(args);
        return Effect.fail({ _tag: 'HttpClientError' });
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(result).toBe(NEW_ROLE_ID);
    expect(restCalls.createGuildRole).toHaveLength(1);
    expect(rpcCalls['Role/UpsertMapping']?.[0]).toMatchObject([
      expect.objectContaining({ discord_role_id: NEW_ROLE_ID, adopted: false }),
    ]);
  });

  it('#13 falls back to createGuildRole when getGuildMember fails (a Discord hiccup, not the -1 fail-safe)', async () => {
    // NOTE (should-fix): this test's original name/rationale claimed to cover the `-1` fail-safe
    // default for an unknown bot position, but `getGuildMember` FAILING short-circuits before
    // `botTopPosition` is ever computed — this actually exercises the `HttpClientError` tier-2
    // REST-failure catch (same family as test #12), not the fail-safe default. The real `-1` path
    // — both REST calls succeed, but the bot's own role id is absent from `listGuildRoles` — is
    // covered separately below (`#13b`).
    const { calls: restCalls, layer: restLayer } = makeRest({
      getGuildMember: (...args: any[]) => {
        restCalls.getGuildMember.push(args);
        return Effect.fail({ _tag: 'HttpClientError' });
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(result).toBe(NEW_ROLE_ID);
    expect(restCalls.createGuildRole).toHaveLength(1);
    expect(rpcCalls['Role/UpsertMapping']?.[0]).toMatchObject([
      expect.objectContaining({ discord_role_id: NEW_ROLE_ID, adopted: false }),
    ]);
  });

  it('#13b covers the REAL -1 fail-safe: both REST calls succeed but the bot has no role in common with listGuildRoles', async () => {
    const OTHER_BOT_ROLE_ID = '777777777777777777';
    const { calls: restCalls, layer: restLayer } = makeRest({
      // A valid-looking candidate (EXISTING_ROLE_ID) is present, but `getGuildMember().roles`
      // shares nothing with `listGuildRoles`'s ids — `botTopPosition` computes to its documented
      // default (-1) via `Arr.reduce(-1, ...)` finding no matching role, NOT via any REST failure.
      getGuildMember: (...args: any[]) => {
        restCalls.getGuildMember.push(args);
        return Effect.succeed({
          avatar: null,
          banner: null,
          communication_disabled_until: null,
          flags: 0,
          joined_at: '2024-01-01T00:00:00.000Z',
          nick: null,
          pending: false,
          premium_since: null,
          roles: [OTHER_BOT_ROLE_ID],
          user: { id: OTHER_BOT_ROLE_ID, username: 'sideline-bot' },
          mute: false,
          deaf: false,
        });
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(restCalls.getGuildMember).toHaveLength(1);
    expect(result).toBe(NEW_ROLE_ID);
    expect(restCalls.createGuildRole).toHaveLength(1);
    expect(rpcCalls['Role/UpsertMapping']?.[0]).toMatchObject([
      expect.objectContaining({ discord_role_id: NEW_ROLE_ID, adopted: false }),
    ]);
  });

  it('#14 logs a warning naming every near-miss and its rejection reason', async () => {
    const { layer: restLayer } = makeRest({
      listGuildRoles: () =>
        Effect.succeed([
          botOwnRole,
          // Name matches, but managed → near-miss.
          makeGuildRole({ id: '600000000000000001', name: ROLE_NAME, managed: true, position: 2 }),
          // Name matches, but non-zero permissions → near-miss.
          makeGuildRole({
            id: '600000000000000002',
            name: ROLE_NAME,
            permissions: '8',
            position: 4,
          }),
        ]),
    });
    const { layer: rpcLayer } = makeSyncRpc();
    const { messages, levels, layer: logLayer } = makeLogCapture();

    await runEnsureMapping(rpcLayer, restLayer, logLayer);

    const warnCount = levels.filter((l) => l.toLowerCase().includes('warn')).length;
    expect(warnCount).toBeGreaterThan(0);
    const joined = messages.join('\n');
    expect(joined).toContain(ROLE_NAME);
    expect(joined).toContain('600000000000000001');
    expect(joined).toContain('600000000000000002');
  });

  it('#15 BLOCKER 1 regression: createGuildRole is reached exactly once (its own internal retries only) when tier 3 itself fails', async () => {
    // Before the fix: two independent `catchTag`s were chained in one `.pipe()`, so the
    // tier-2-REST-failure catch also caught failures coming out of tier 3's `createGuildRole`
    // call, invoking it a SECOND time. This test drives a real (non-REST-failure) tier-2 miss —
    // no candidate matches the name — so createGuildRole is reached once, and makes its
    // underlying REST call fail every time so its own `Effect.retry(retryPolicy)` (recurs(3) = 4
    // attempts) exhausts. The buggy code invoked createGuildRole's REST call twice as many times
    // (8) as the fixed code (4).
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildRoles: (...args: any[]) => {
        restCalls.listGuildRoles.push(args);
        return Effect.succeed([
          botOwnRole,
          makeGuildRole({ id: '444444444444444444', name: 'Not Captain', position: 3 }),
        ]);
      },
      createGuildRole: (...args: any[]) => {
        restCalls.createGuildRole.push(args);
        return Effect.fail({ _tag: 'HttpClientError' });
      },
    });
    const { layer: rpcLayer } = makeSyncRpc();

    await expect(runEnsureMapping(rpcLayer, restLayer)).rejects.toBeDefined();

    // recurs(3) = 1 initial attempt + 3 retries = 4 REST calls for ONE createGuildRole
    // invocation. The pre-fix bug would double this to 8.
    expect(restCalls.createGuildRole).toHaveLength(4);
  }, 20000); // Effect.retry(retryPolicy) is exponential(1s) × 3 ≈ 7s of real waits.

  it('should-fix: falls back to createGuildRole when Role/UpsertMapping reports DiscordRoleAlreadyMapped', async () => {
    // 23505 on UNIQUE(team_id, discord_role_id) — reachable via a Sideline role rename followed
    // by a different role adopting the same Discord role. Must fall through to create rather
    // than strand the event as a terminal RpcClientError.
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc({
      'Role/UpsertMapping': (...args: any[]) => {
        rpcCalls['Role/UpsertMapping']?.push(args);
        const [payload] = args;
        // Only the adoption-tier upsert (adopted: true) conflicts; the create-tier retry
        // (adopted: false) must succeed so the fallback actually completes.
        return payload?.adopted === true
          ? Effect.fail({ _tag: 'DiscordRoleAlreadyMapped' })
          : Effect.void;
      },
    });

    const result = await runEnsureMapping(rpcLayer, restLayer);

    expect(result).toBe(NEW_ROLE_ID);
    expect(restCalls.createGuildRole).toHaveLength(1);
    const upsertCalls = rpcCalls['Role/UpsertMapping'];
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls?.[1]).toMatchObject([
      expect.objectContaining({ discord_role_id: NEW_ROLE_ID, adopted: false }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// A bot token may not call user-OAuth endpoints
//
// `getMyGuildMember` is `GET /users/@me/guilds/{id}/member`, which answers
// `20001 "Bots cannot use this endpoint"` for every bot token. Adoption called
// it, so it failed 100% of the time in production and every role fell through
// to `createGuildRole` — precisely the duplicate-role outcome adoption exists
// to prevent. The suite stayed green throughout because the mock returned a
// success for an endpoint Discord would never have answered.
//
// The default mock now returns the real 20001, so any return to that endpoint
// breaks the adoption tests on its own. This states the rule outright as well,
// because the next person to reach for "the bot's own member" will find
// `getMyGuildMember` by name and it reads like the obvious choice.
// ---------------------------------------------------------------------------

describe('ensureMapping and user-OAuth endpoints', () => {
  it('never calls getMyGuildMember — a bot token always gets 20001 there', async () => {
    // The default `Role/GetMapping` returns `Option.none()`, which is what
    // sends this down the adopt path.
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await runEnsureMapping(rpcLayer, restLayer);

    expect(restCalls.getMyGuildMember).toHaveLength(0);
    // The bot-callable pair instead: who am I, then my member in this guild.
    expect(restCalls.getMyUser).toHaveLength(1);
    expect(restCalls.getGuildMember).toHaveLength(1);
    expect(restCalls.getGuildMember[0]).toEqual([GUILD_ID, BOT_USER_ID]);
  });
});
