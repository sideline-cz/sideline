/**
 * TDD tests for handleRosterRoleReconcile.
 *
 * The production file does NOT yet exist. These tests are expected to FAIL (compile-error or
 * runtime-fail) until `applications/bot/src/rcp/channel/handleRosterRoleReconcile.ts` is created.
 *
 * Planned contract:
 *   handleRosterRoleReconcile(event: RosterRoleReconcileEvent)
 *     → Effect.Effect<void, never, SyncRpc | DiscordREST>
 *
 * Behavior:
 *   1. Calls rpc['Channel/GetExpectedRoleHolders']({ team_id, discord_role_id }).
 *   2. Paginates rest.listGuildMembers(guild_id, { limit: 1000, after }) until a page has < 1000
 *      members or 50 pages are exhausted. The `after` param for page N+1 is String(last member's
 *      user.id on page N).
 *   3. Computes extras = guild holders with the role − expected holders (by discord_user_id).
 *   4. Calls rest.deleteGuildMemberRole(guild_id, userId, roleId) per extra with concurrency 1.
 *      - Permanent errors (ErrorResponse 403/50013 or 404/10007 Unknown Member) are NOT retried
 *        and are logged-then-continued.
 *      - Transient errors (5xx HttpClientError) are retried per the standard retryPolicy.
 *   5. If listGuildMembers itself fails → log + remove NOBODY + succeed (void).
 */

import type { ChannelRpcEvents, ChannelRpcModels } from '@sideline/domain';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
// NOTE: This import will fail until the production file is created — expected in TDD mode.
import { handleRosterRoleReconcile } from '~/rcp/channel/handleRosterRoleReconcile.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999000000000000001' as ChannelRpcEvents.RosterRoleReconcileEvent['guild_id'];
const TEAM_ID =
  '00000000-0000-0000-0000-000000000010' as ChannelRpcEvents.RosterRoleReconcileEvent['team_id'];
const ROSTER_ID =
  '00000000-0000-0000-0000-000000000030' as ChannelRpcEvents.RosterRoleReconcileEvent['roster_id'];
const ROLE_ID =
  '999000000000000002' as ChannelRpcEvents.RosterRoleReconcileEvent['discord_role_id'];
const EVENT_ID =
  '00000000-0000-0000-0000-000000000001' as ChannelRpcEvents.RosterRoleReconcileEvent['id'];

const makeEvent = (
  overrides: Partial<ChannelRpcEvents.RosterRoleReconcileEvent> = {},
): ChannelRpcEvents.RosterRoleReconcileEvent =>
  ({
    _tag: 'roster_role_reconcile' as const,
    id: EVENT_ID,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    roster_id: ROSTER_ID,
    discord_role_id: ROLE_ID,
    ...overrides,
  }) as unknown as ChannelRpcEvents.RosterRoleReconcileEvent;

// ---------------------------------------------------------------------------
// DiscordREST stub helpers
// ---------------------------------------------------------------------------

interface RestStubOptions {
  listGuildMembers?: ReturnType<typeof vi.fn>;
  deleteGuildMemberRole?: ReturnType<typeof vi.fn>;
}

/**
 * Builds a DiscordREST stub.  Any method not overridden falls back to a
 * no-op Effect.succeed(undefined) — matching summon/handler.test.ts pattern.
 */
const makeRestStub = (options: RestStubOptions = {}) => {
  const listGuildMembers = options.listGuildMembers ?? vi.fn(() => Effect.succeed([]));
  const deleteGuildMemberRole =
    options.deleteGuildMemberRole ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'listGuildMembers') return listGuildMembers;
      if (prop === 'deleteGuildMemberRole') return deleteGuildMemberRole;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, listGuildMembers, deleteGuildMemberRole };
};

// ---------------------------------------------------------------------------
// SyncRpc stub helpers
// ---------------------------------------------------------------------------

interface RpcStubOptions {
  GetExpectedRoleHolders?: ReturnType<typeof vi.fn>;
}

const makeRpcStub = (options: RpcStubOptions = {}) => {
  const getExpectedRoleHolders = options.GetExpectedRoleHolders ?? vi.fn(() => Effect.succeed([]));

  const rpcClient = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (prop === 'Channel/GetExpectedRoleHolders') return getExpectedRoleHolders;
      return () => Effect.succeed(undefined);
    },
  });

  const layer = Layer.succeed(SyncRpc, rpcClient as any);
  return { layer, getExpectedRoleHolders };
};

// ---------------------------------------------------------------------------
// Member fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Discord guild member fixture with the given user id and
 * optional roles list.  The roles array must include ROLE_ID for a member to
 * be counted as a "current holder" in the handler.
 */
const makeMember = (userId: string, roles: string[] = [ROLE_ID]) => ({
  user: {
    id: userId,
    username: `user-${userId}`,
    discriminator: '0000',
    global_name: null,
    avatar: null,
  },
  roles,
  joined_at: '2024-01-01T00:00:00Z',
  deaf: false,
  mute: false,
  pending: false,
  flags: 0,
  nick: null,
  premium_since: null,
  banner: null,
  communication_disabled_until: null,
  avatar_decoration_data: null,
});

/**
 * Creates a RosterMemberDiscord fixture (the domain type returned by GetExpectedRoleHolders).
 */
const makeExpected = (discordUserId: string): ChannelRpcModels.RosterMemberDiscord =>
  ({
    team_member_id: `00000000-0000-0000-0000-${discordUserId.slice(0, 12).padStart(12, '0')}`,
    discord_user_id: discordUserId,
  }) as unknown as ChannelRpcModels.RosterMemberDiscord;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const runHandler = (
  event: ChannelRpcEvents.RosterRoleReconcileEvent,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) =>
  Effect.runPromise(
    handleRosterRoleReconcile(event).pipe(Effect.provide(restLayer), Effect.provide(rpcLayer)),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRosterRoleReconcile', () => {
  // -------------------------------------------------------------------------
  // (a) holders {A,B,C}, expected {A,B} → delete called once for C only
  // -------------------------------------------------------------------------
  it('deletes only the extra holder (C) when expected is {A,B} and holders are {A,B,C}', async () => {
    const userA = '100000000000000001';
    const userB = '100000000000000002';
    const userC = '100000000000000003'; // extra — must be removed

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() =>
        Effect.succeed([makeExpected(userA), makeExpected(userB)]),
      ),
    });
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() =>
        Effect.succeed([
          makeMember(userA), // has ROLE_ID
          makeMember(userB), // has ROLE_ID
          makeMember(userC), // has ROLE_ID — extra
        ]),
      ),
    });

    await runHandler(makeEvent(), rest.layer, rpc.layer);

    expect(rest.deleteGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(rest.deleteGuildMemberRole).toHaveBeenCalledWith(GUILD_ID, userC, ROLE_ID);
  });

  // -------------------------------------------------------------------------
  // (b) holders == expected → zero deletes
  // -------------------------------------------------------------------------
  it('makes zero deleteGuildMemberRole calls when holders exactly match expected', async () => {
    const userA = '200000000000000001';
    const userB = '200000000000000002';

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() =>
        Effect.succeed([makeExpected(userA), makeExpected(userB)]),
      ),
    });
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() => Effect.succeed([makeMember(userA), makeMember(userB)])),
    });

    await runHandler(makeEvent(), rest.layer, rpc.layer);

    expect(rest.deleteGuildMemberRole).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (c) SHARED-ROLE UNION: expected {A,B,C,D}, holders {A,B,C,D,E} → only E removed
  // -------------------------------------------------------------------------
  it('SHARED-ROLE UNION: only E is removed when expected={A,B,C,D} and holders={A,B,C,D,E}', async () => {
    const userA = '300000000000000001';
    const userB = '300000000000000002';
    const userC = '300000000000000003';
    const userD = '300000000000000004';
    const userE = '300000000000000005'; // only extra

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() =>
        Effect.succeed([
          makeExpected(userA),
          makeExpected(userB),
          makeExpected(userC),
          makeExpected(userD),
        ]),
      ),
    });
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() =>
        Effect.succeed([
          makeMember(userA),
          makeMember(userB),
          makeMember(userC),
          makeMember(userD),
          makeMember(userE), // extra
        ]),
      ),
    });

    await runHandler(makeEvent(), rest.layer, rpc.layer);

    expect(rest.deleteGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(rest.deleteGuildMemberRole).toHaveBeenCalledWith(GUILD_ID, userE, ROLE_ID);
  });

  // -------------------------------------------------------------------------
  // (d) PAGINATION: page1=1000, page2<1000; assert `after` for page2 is the
  //     last user.id of page1 AS STRING; diff = union of both pages
  // -------------------------------------------------------------------------
  it('PAGINATION: fetches page2 with after=String(last page1 user.id); extras span both pages', async () => {
    // Build 1000 members for page 1, all holding the role, all in expected set
    const page1Members = Array.from({ length: 1000 }, (_, i) => {
      const id = String(4000000000000 + i).padStart(18, '4');
      return makeMember(id); // holds ROLE_ID
    });
    const lastPage1UserId = page1Members[999]?.user.id; // the `after` cursor for page 2

    // Page 2: one expected member + one extra
    const expectedOnPage2 = '500000000000000001';
    const extraOnPage2 = '500000000000000002'; // not in expected → should be deleted

    const page2Members = [makeMember(expectedOnPage2), makeMember(extraOnPage2)];

    const allExpectedIds = [...page1Members.map((m) => m.user.id), expectedOnPage2];

    const listGuildMembers = vi
      .fn()
      .mockImplementation((_guildId: string, opts: { limit: number; after?: string }) => {
        if (!opts.after) {
          // First call — return 1000 members (triggers pagination)
          return Effect.succeed(page1Members);
        }
        // Second call — return page2 (< 1000 members — terminates pagination)
        return Effect.succeed(page2Members);
      });

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() => Effect.succeed(allExpectedIds.map(makeExpected))),
    });
    const rest = makeRestStub({ listGuildMembers });

    await runHandler(makeEvent(), rest.layer, rpc.layer);

    // First call must NOT pass an `after` param (or pass undefined/null)
    const firstCallOpts = listGuildMembers.mock.calls[0]?.[1] as
      | { limit: number; after?: string }
      | undefined;
    expect(firstCallOpts?.after).toBeFalsy();

    // Second call must pass after = String(lastPage1UserId)
    const secondCallOpts = listGuildMembers.mock.calls[1]?.[1] as
      | { limit: number; after?: string }
      | undefined;
    expect(secondCallOpts?.after).toBe(String(lastPage1UserId));

    // Only the extra on page 2 should be deleted
    expect(rest.deleteGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(rest.deleteGuildMemberRole).toHaveBeenCalledWith(GUILD_ID, extraOnPage2, ROLE_ID);
  });

  // -------------------------------------------------------------------------
  // (e) empty guild → zero deletes
  // -------------------------------------------------------------------------
  it('makes zero deleteGuildMemberRole calls when the guild has no members', async () => {
    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() => Effect.succeed([])),
    });
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() => Effect.succeed([])),
    });

    await runHandler(makeEvent(), rest.layer, rpc.layer);

    expect(rest.deleteGuildMemberRole).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (f) permanent delete failure (ErrorResponse 403 code 50013 or 404 Unknown
  //     Member) → NOT retried, logged, continues to next extra
  //
  // We verify this by having TWO extras: the first gets a permanent 403, the
  // second gets a permanent 404 Unknown Member (code 10007).  The handler must
  // attempt both deletes (i.e., continue past the first failure) and NOT
  // propagate an error (the Effect resolves successfully).
  // -------------------------------------------------------------------------
  it('permanent delete failure (403/50013 or 404/10007) — continues to next extra and resolves', async () => {
    const userA = '600000000000000001'; // expected — must NOT be deleted
    const extraX = '600000000000000002'; // extra — 403 permanent failure
    const extraY = '600000000000000003'; // extra — 404 Unknown Member

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() => Effect.succeed([makeExpected(userA)])),
    });

    // deleteGuildMemberRole alternates: first call → 403, second call → 404
    let deleteCallCount = 0;
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() =>
        Effect.succeed([makeMember(userA), makeMember(extraX), makeMember(extraY)]),
      ),
      deleteGuildMemberRole: vi.fn(() => {
        deleteCallCount++;
        if (deleteCallCount === 1) {
          // 403 Missing Permissions
          return Effect.fail({
            _tag: 'ErrorResponse' as const,
            response: { status: 403 },
            data: { code: 50013, message: 'Missing Permissions' },
            message: 'Missing Permissions',
          });
        }
        // 404 Unknown Member
        return Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 404 },
          data: { code: 10007, message: 'Unknown Member' },
          message: 'Unknown Member',
        });
      }),
    });

    // The handler MUST NOT throw — permanent errors are logged and skipped
    await expect(runHandler(makeEvent(), rest.layer, rpc.layer)).resolves.toBeUndefined();

    // Both deletes were attempted (handler continued past the first permanent error)
    expect(rest.deleteGuildMemberRole).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // (g) transient delete failure (5xx HttpClientError) → retried per retryPolicy
  //
  // We verify that a transient failure (resolved on retry) does NOT abort the
  // handler; we also check that the same user IS eventually deleted (the retry
  // resolved) and the effect resolves successfully.
  // -------------------------------------------------------------------------
  it('transient delete failure (5xx) is retried and handler resolves successfully', async () => {
    const userA = '700000000000000001'; // expected
    const extraZ = '700000000000000002'; // extra — first call fails transiently, second succeeds

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() => Effect.succeed([makeExpected(userA)])),
    });

    let deleteAttempts = 0;
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() => Effect.succeed([makeMember(userA), makeMember(extraZ)])),
      deleteGuildMemberRole: vi.fn(() => {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          // Simulate a 503 transient error as an HttpClientError-like structure
          return Effect.fail({
            _tag: 'ResponseError' as const,
            response: { status: 503 },
            message: 'Service Unavailable',
          });
        }
        return Effect.succeed(undefined);
      }),
    });

    await expect(runHandler(makeEvent(), rest.layer, rpc.layer)).resolves.toBeUndefined();

    // Must have been retried — at least 2 calls
    expect(deleteAttempts).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // (h) SAFETY: listGuildMembers fails (403) → ZERO deletes AND effect succeeds
  //
  // If the guild member list cannot be fetched, the handler must delete nobody
  // (don't accidentally nuke everyone) and still resolve successfully (don't
  // propagate the error to the processor).
  // -------------------------------------------------------------------------
  it('SAFETY: listGuildMembers failure → ZERO deletes and effect resolves (void)', async () => {
    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() => Effect.succeed([makeExpected('800000000000000001')])),
    });
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 403 },
          data: { code: 50013, message: 'Missing Permissions' },
          message: 'Missing Permissions',
        }),
      ),
    });

    // Must resolve (not reject) and make zero deletes
    await expect(runHandler(makeEvent(), rest.layer, rpc.layer)).resolves.toBeUndefined();

    expect(rest.deleteGuildMemberRole).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (i) REGRESSION: GetExpectedRoleHolders RPC FAILS → handler FAILS (propagates)
  //     AND zero deleteGuildMemberRole calls are made.
  //
  // This guards against the fail-open bug where orElseSucceed(() => []) caused
  // an RPC failure to produce an empty expected set, removing the role from ALL
  // current holders.  With the fix the RPC error must propagate so the event is
  // retried rather than acting on an empty expected set.
  // -------------------------------------------------------------------------
  it('REGRESSION: GetExpectedRoleHolders failure → handler propagates error and makes ZERO deletes', async () => {
    const userA = '910000000000000001'; // holds the role in Discord

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() =>
        Effect.fail({
          _tag: 'RpcClientError' as const,
          message: 'Connection refused',
        }),
      ),
    });
    const rest = makeRestStub({
      listGuildMembers: vi.fn(() => Effect.succeed([makeMember(userA)])),
    });

    // The handler must FAIL (reject) — the RPC error propagates
    await expect(runHandler(makeEvent(), rest.layer, rpc.layer)).rejects.toBeDefined();

    // Zero deletes: we must NOT have acted on an empty expected set
    expect(rest.deleteGuildMemberRole).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (j) MID-PAGINATION FAILURE: listGuildMembers succeeds on page 1 (1000
  //     members) then FAILS on page 2 → ZERO deletes AND effect succeeds (void).
  //
  // When the member list is incomplete (page 2 read failed), the handler must
  // not remove anyone — the holder set is unknown, so removing based on a
  // partial view could strip valid members.
  // -------------------------------------------------------------------------
  it('MID-PAGINATION FAILURE: page2 listGuildMembers failure → ZERO deletes and effect resolves', async () => {
    // Build 1000 members for page 1, all holding the role
    const page1Members = Array.from({ length: 1000 }, (_, i) => {
      const id = String(9000000000000 + i).padStart(18, '9');
      return makeMember(id);
    });

    // One member that would have been on page 2 — they are in the expected set
    const expectedOnPage2 = '950000000000000001';

    const listGuildMembers = vi
      .fn()
      .mockImplementationOnce(() => Effect.succeed(page1Members)) // page 1 succeeds
      .mockImplementationOnce(() =>
        // page 2 fails — simulates a transient network error
        Effect.fail({
          _tag: 'HttpClientError' as const,
          response: { status: 503 },
          message: 'Service Unavailable',
        }),
      );

    const rpc = makeRpcStub({
      GetExpectedRoleHolders: vi.fn(() =>
        Effect.succeed([
          ...page1Members.map((m) => makeExpected(m.user.id)),
          makeExpected(expectedOnPage2),
        ]),
      ),
    });
    const rest = makeRestStub({ listGuildMembers });

    // The handler must resolve (not fail) — incomplete reads are treated as "no-op"
    await expect(runHandler(makeEvent(), rest.layer, rpc.layer)).resolves.toBeUndefined();

    // Zero deletes: incomplete member list means we cannot safely compute extras
    expect(rest.deleteGuildMemberRole).not.toHaveBeenCalled();
  });
});
