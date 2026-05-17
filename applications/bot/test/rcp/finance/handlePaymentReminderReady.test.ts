// TDD mode — tests written BEFORE handlePaymentReminderReady implementation.
// These tests WILL FAIL until the developer implements:
//   - applications/bot/src/rcp/finance/handlePaymentReminderReady.ts
//   - The handler must: DM the user, send an embed, then call Finance/MarkReminderSent on success
//   - On Discord error: must NOT call Finance/MarkReminderSent, and propagate the error

import type { Discord, FeeAssignment, Team } from '@sideline/domain';
import {
  type Fee,
  FinanceRpcEvents as FinanceRpcEventsNS,
  type PaymentReminder,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { handlePaymentReminderReady } from '~/rcp/finance/handlePaymentReminderReady.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const ASSIGNMENT_ID = '00000000-0000-0000-0000-000000000040' as FeeAssignment.FeeAssignmentId;
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;
const DM_CHANNEL_ID = '333333333333333333' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeEvent = (
  overrides: Partial<{
    kind: PaymentReminder.PaymentReminderKind;
    fee_name: string;
    amount_minor: Fee.AmountMinor;
    paid_minor: Fee.AmountMinor;
    currency: Fee.CurrencyCode;
  }> = {},
): FinanceRpcEventsNS.PaymentReminderReadyEvent =>
  new FinanceRpcEventsNS.PaymentReminderReadyEvent({
    id: '00000000-0000-0000-0000-000000000001',
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    assignment_id: ASSIGNMENT_ID,
    kind: 'due_today' as PaymentReminder.PaymentReminderKind,
    fee_name: 'Annual Fee',
    effective_due_at: new Date().toISOString(),
    currency: 'CZK' as Fee.CurrencyCode,
    amount_minor: 5000 as Fee.AmountMinor,
    paid_minor: 0 as Fee.AmountMinor,
    user_discord_id: DISCORD_USER_ID,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// DiscordREST mock helpers
// ---------------------------------------------------------------------------

type RestCallRecord = {
  createDm: unknown[][];
  createMessage: unknown[][];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = {
    createDm: [],
    createMessage: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createDm: (...args: any[]) => {
      calls.createDm.push(args);
      return Effect.succeed({ id: DM_CHANNEL_ID });
    },
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args);
      return Effect.succeed({ id: 'msg-123' });
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) return () => Effect.void;
        return fn;
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// SyncRpc mock helper
// ---------------------------------------------------------------------------

const makeSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: Record<string, unknown[][]>; layer: Layer.Layer<SyncRpc> } => {
  const calls: Record<string, unknown[][]> = {
    'Finance/MarkReminderSent': [],
    'Finance/MarkPaymentReminderProcessed': [],
    'Finance/MarkPaymentReminderFailed': [],
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop];
        if (fn) return fn;
        return (...args: any[]) => {
          if (!(prop in calls)) calls[prop] = [];
          calls[prop].push(args);
          return Effect.void;
        };
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Helper to run handler
// ---------------------------------------------------------------------------

const runHandler = (
  event: FinanceRpcEventsNS.PaymentReminderReadyEvent,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) =>
  Effect.runPromise(
    handlePaymentReminderReady(event).pipe(
      Effect.provide(Layer.merge(restLayer, rpcLayer)),
    ) as Effect.Effect<void>,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handlePaymentReminderReady', () => {
  it('calls rest.createDm with the event user_discord_id', async () => {
    const { calls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await runHandler(makeEvent(), restLayer, rpcLayer);

    expect(calls.createDm).toHaveLength(1);
    const [dmArg] = calls.createDm[0] as [{ recipient_id: string }];
    expect(dmArg).toMatchObject({ recipient_id: DISCORD_USER_ID });
  });

  it('calls rest.createMessage with the DM channel id returned by createDm', async () => {
    const { calls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await runHandler(makeEvent(), restLayer, rpcLayer);

    expect(calls.createMessage).toHaveLength(1);
    const [channelArg] = calls.createMessage[0] as [string, unknown];
    expect(channelArg).toBe(DM_CHANNEL_ID);
  });

  it('embed contains the fee name', async () => {
    const { calls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await runHandler(makeEvent({ fee_name: 'Equipment Fee' }), restLayer, rpcLayer);

    const [, messageBody] = calls.createMessage[0] as [string, { embeds?: any[] }];
    const embedText = JSON.stringify(messageBody);
    expect(embedText).toContain('Equipment Fee');
  });

  it('embed contains the amount and currency', async () => {
    const { calls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await runHandler(
      makeEvent({ amount_minor: 7500 as Fee.AmountMinor, currency: 'EUR' as Fee.CurrencyCode }),
      restLayer,
      rpcLayer,
    );

    const [, messageBody] = calls.createMessage[0] as [string, { embeds?: any[] }];
    const embedText = JSON.stringify(messageBody);
    // Amount (in major units or minor, implementation-defined) and currency should appear
    expect(embedText).toMatch(/EUR|7500|75/);
  });

  it('embed contains kind-appropriate copy for due_today', async () => {
    const { calls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await runHandler(makeEvent({ kind: 'due_today' }), restLayer, rpcLayer);

    const [, messageBody] = calls.createMessage[0] as [string, { embeds?: any[] }];
    const embedText = JSON.stringify(messageBody);
    // Some indication of "today" or "due" in the embed
    expect(embedText.toLowerCase()).toMatch(/today|due/);
  });

  it('embed contains kind-appropriate copy for overdue_3d', async () => {
    const { calls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await runHandler(makeEvent({ kind: 'overdue_3d' }), restLayer, rpcLayer);

    const [, messageBody] = calls.createMessage[0] as [string, { embeds?: any[] }];
    const embedText = JSON.stringify(messageBody);
    // Some indication of "overdue" in the embed
    expect(embedText.toLowerCase()).toMatch(/overdue|3/);
  });

  it('on success: calls Finance/MarkReminderSent with assignment_id and kind', async () => {
    const { layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const event = makeEvent({ kind: 'due_in_3d' });
    await runHandler(event, restLayer, rpcLayer);

    const sentCalls = rpcCalls['Finance/MarkReminderSent'];
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0]).toMatchObject([
      expect.objectContaining({
        assignment_id: ASSIGNMENT_ID,
        kind: 'due_in_3d',
      }),
    ]);
  });

  it('on Discord createDm error (HTTP 500): does NOT call Finance/MarkReminderSent', async () => {
    const { layer: restLayer } = makeRest({
      createDm: () => Effect.fail(new Error('Discord HTTP 500')),
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    await expect(runHandler(makeEvent(), restLayer, rpcLayer)).rejects.toThrow();

    const sentCalls = rpcCalls['Finance/MarkReminderSent'];
    expect(sentCalls).toHaveLength(0);
  });

  it('on Discord createMessage error (HTTP 500): does NOT call Finance/MarkReminderSent and propagates error', async () => {
    const { layer: restLayer } = makeRest({
      createMessage: () => Effect.fail(new Error('Discord HTTP 500 on message')),
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    await expect(runHandler(makeEvent(), restLayer, rpcLayer)).rejects.toThrow();

    const sentCalls = rpcCalls['Finance/MarkReminderSent'];
    expect(sentCalls).toHaveLength(0);
  });

  it('does NOT call Finance/MarkReminderSent before createMessage succeeds', async () => {
    // Verify ordering: MarkReminderSent must come AFTER createMessage
    const operationOrder: string[] = [];

    const { layer: restLayer } = makeRest({
      createDm: () => {
        operationOrder.push('createDm');
        return Effect.succeed({ id: DM_CHANNEL_ID });
      },
      createMessage: () => {
        operationOrder.push('createMessage');
        return Effect.succeed({ id: 'msg-1' });
      },
    });
    const { layer: rpcLayer } = makeSyncRpc({
      'Finance/MarkReminderSent': (..._args: any[]) => {
        operationOrder.push('MarkReminderSent');
        return Effect.void;
      },
    });

    await runHandler(makeEvent(), restLayer, rpcLayer);

    expect(operationOrder).toEqual(['createDm', 'createMessage', 'MarkReminderSent']);
  });
});
