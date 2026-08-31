// PR-9 (Discord onboarding fix), 9b — `ProcessorService.ts:43` used to record `String(error)` on
// `Role/MarkEventFailed`. This pins that it now classifies the error via
// `classifyRoleSyncError` (`errorClassifier.ts`) and sends the classified `error_code` instead —
// `Option.some(code)` when the classifier says `terminal: true`, `Option.none()` when it says
// `terminal: false` (CC-0: a 429 or a Discord 5xx must never be recorded as a user-visible
// failure on `team_members.last_role_sync_*`).
//
// Pattern: `applications/bot/test/rcp/inviteGenerator/ProcessorService.test.ts`.

import {
  type Discord,
  type Role,
  RoleRpcEvents,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProcessorService } from '~/rcp/role/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000030' as Team.TeamId;
const ROLE_ID = '00000000-0000-0000-0000-000000000031' as Role.RoleId;
const TEAM_MEMBER_ID = '00000000-0000-0000-0000-000000000032' as TeamMember.TeamMemberId;
const DISCORD_USER_ID = '444444444444444444' as Discord.Snowflake;
const DISCORD_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const EVENT_ID = '00000000-0000-0000-0000-000000000033' as RoleRpcEvents.RoleUnassignedEvent['id'];

const EVENT_ID_2 = '00000000-0000-0000-0000-000000000034' as RoleRpcEvents.RoleAssignedEvent['id'];
const ROLE_ID_2 = '00000000-0000-0000-0000-000000000035' as Role.RoleId;
const DISCORD_ROLE_ID_2 = '666666666666666666' as Discord.Snowflake;

const makeAssignedEvent = (
  id: RoleRpcEvents.RoleAssignedEvent['id'],
  roleId: Role.RoleId,
  roleName: string,
) =>
  new RoleRpcEvents.RoleAssignedEvent({
    id,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    role_id: roleId,
    role_name: roleName,
    team_member_id: TEAM_MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
  });

const makeUnassignedEvent = () =>
  new RoleRpcEvents.RoleUnassignedEvent({
    id: EVENT_ID,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    role_id: ROLE_ID,
    team_member_id: TEAM_MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
  });

type AnyFn = (...args: any[]) => Effect.Effect<any, any, any>;

type RpcCalls = {
  MarkEventProcessed: Array<{ id: string; tick_started_at: DateTime.Utc }>;
  MarkEventFailed: Array<{ id: string; error: string; error_code: Option.Option<string> }>;
};

const makeRpc = (
  overrides: Partial<Record<string, AnyFn>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = { MarkEventProcessed: [], MarkEventFailed: [] };

  const defaults: Record<string, AnyFn> = {
    'Role/GetMapping': () =>
      Effect.succeed(
        Option.some({
          id: 'mapping-1',
          team_id: TEAM_ID,
          role_id: ROLE_ID,
          discord_role_id: DISCORD_ROLE_ID,
          adopted: false,
        }),
      ),
    'Role/MarkEventProcessed': (args: { id: string; tick_started_at: DateTime.Utc }) => {
      calls.MarkEventProcessed.push(args);
      return Effect.void;
    },
    'Role/MarkEventFailed': (args: {
      id: string;
      error: string;
      error_code: Option.Option<string>;
    }) => {
      calls.MarkEventFailed.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) throw new Error(`Unmocked RPC method: ${prop}`);
        return fn;
      },
    }),
  );

  return { calls, layer };
};

const makeRest = (overrides: Partial<Record<string, AnyFn>> = {}): Layer.Layer<DiscordREST> => {
  const defaults: Record<string, AnyFn> = {
    deleteGuildMemberRole: () => Effect.void,
  };

  return Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        return fn ?? (() => Effect.void);
      },
    }),
  );
};

const runOneTick = (
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
): Promise<void> =>
  Effect.runPromise(
    ProcessorService.pipe(
      Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
      Effect.provide(Layer.merge(rpcLayer, restLayer)),
    ),
  );

describe('role ProcessorService — classified error_code on MarkEventFailed', () => {
  it('sends error_code=Some(captain_action) for a terminal 50013 failure', async () => {
    const { calls, layer: rpcLayer } = makeRpc({
      'Role/GetUnprocessedEvents': () => Effect.succeed([makeUnassignedEvent()]),
    });
    const restLayer = makeRest({
      deleteGuildMemberRole: () =>
        Effect.fail({ _tag: 'ErrorResponse', code: 50013, message: 'Missing Permissions' }),
    });

    await runOneTick(rpcLayer, restLayer);

    expect(calls.MarkEventFailed).toHaveLength(1);
    const call = calls.MarkEventFailed[0];
    expect(call).toBeDefined();
    expect(Option.isSome(call?.error_code ?? Option.none())).toBe(true);
    expect(Option.getOrNull(call?.error_code ?? Option.none())).toBe('captain_action');
  }, 20000); // Effect.retry(retryPolicy) exhausts ~7s of exponential backoff first.

  it('sends error_code=None for a transient (retryable) failure — never a user-visible sync failure', async () => {
    const { calls, layer: rpcLayer } = makeRpc({
      'Role/GetUnprocessedEvents': () => Effect.succeed([makeUnassignedEvent()]),
    });
    const restLayer = makeRest({
      deleteGuildMemberRole: () =>
        Effect.fail({
          _tag: 'HttpClientError',
          reason: { _tag: 'StatusCodeError' },
          response: { status: 503 },
        }),
    });

    await runOneTick(rpcLayer, restLayer);

    expect(calls.MarkEventFailed).toHaveLength(1);
    const call = calls.MarkEventFailed[0];
    expect(call).toBeDefined();
    expect(Option.isNone(call?.error_code ?? Option.some('x'))).toBe(true);
  }, 20000);
});

// Should-fix 1 (whole-series review of commit 46806427): `Role/MarkEventProcessed` must carry the
// SAME `tick_started_at` for every event a single `processTick` drains, so the server can guard a
// same-tick `'ok'` write from clobbering a same-tick `'failed'` write for a different role on the
// same member — see `RoleSyncEventsRepository.recordLastRoleSync`'s doc comment.
describe('role ProcessorService — tick_started_at (should-fix 1)', () => {
  it('sends the same tick_started_at on Role/MarkEventProcessed for every event processed in one tick', async () => {
    const { calls, layer: rpcLayer } = makeRpc({
      'Role/GetUnprocessedEvents': () =>
        Effect.succeed([
          makeAssignedEvent(EVENT_ID, ROLE_ID, 'Captain'),
          makeAssignedEvent(EVENT_ID_2, ROLE_ID_2, 'Coach'),
        ]),
      'Role/GetMapping': (args: { role_id: string }) =>
        Effect.succeed(
          Option.some(
            args.role_id === ROLE_ID
              ? {
                  id: 'mapping-1',
                  team_id: TEAM_ID,
                  role_id: ROLE_ID,
                  discord_role_id: DISCORD_ROLE_ID,
                  adopted: false,
                }
              : {
                  id: 'mapping-2',
                  team_id: TEAM_ID,
                  role_id: ROLE_ID_2,
                  discord_role_id: DISCORD_ROLE_ID_2,
                  adopted: false,
                },
          ),
        ),
    });
    const restLayer = makeRest({
      listGuildRoles: () =>
        Effect.succeed([
          { id: DISCORD_ROLE_ID, permissions: '0' },
          { id: DISCORD_ROLE_ID_2, permissions: '0' },
        ]),
      addGuildMemberRole: () => Effect.void,
    });

    await runOneTick(rpcLayer, restLayer);

    expect(calls.MarkEventProcessed).toHaveLength(2);
    const [first, second] = calls.MarkEventProcessed;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.tick_started_at).toBeDefined();
    expect(DateTime.isDateTime(first?.tick_started_at)).toBe(true);
    expect(
      first !== undefined &&
        second !== undefined &&
        DateTime.Equivalence(first.tick_started_at, second.tick_started_at),
    ).toBe(true);
  });
});
