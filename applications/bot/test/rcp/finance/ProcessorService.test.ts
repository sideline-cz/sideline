// Tests for the finance ProcessorService — verifies BOTH passes of `processTick` run
// (payment reminders, then the T10b bank-token-expiry DM) and that a failure in one pass does
// not prevent the other from running or being polled.

import type { Team } from '@sideline/domain';
import { type Discord, FinanceRpcEvents, FinanceRpcModels } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProcessorService } from '~/rcp/finance/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;
const DM_CHANNEL_ID = '333333333333333333' as Discord.Snowflake;

const reminderEvent = new FinanceRpcEvents.PaymentReminderReadyEvent({
  id: 'reminder-1',
  team_id: TEAM_ID,
  guild_id: GUILD_ID,
  assignment_id: '00000000-0000-0000-0000-000000000040' as never,
  kind: 'due_today',
  fee_name: 'Annual Fee',
  effective_due_at: new Date().toISOString(),
  currency: 'CZK' as never,
  amount_minor: 5000 as never,
  paid_minor: 0 as never,
  user_discord_id: DISCORD_USER_ID,
});

const expiryEvent = new FinanceRpcEvents.BankTokenExpiringEvent({
  id: 'expiry-1',
  team_id: TEAM_ID,
  guild_id: GUILD_ID,
  user_discord_id: DISCORD_USER_ID,
  days_until_expiry: 7,
});

type Calls = Record<string, unknown[][]>;

const makeRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: Calls; layer: Layer.Layer<SyncRpc> } => {
  const calls: Calls = {};

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Finance/GetUnprocessedPaymentReminders': () => Effect.succeed([]),
    'Finance/GetUnprocessedBankTokenExpiryEvents': () => Effect.succeed([]),
    'Finance/GetPaymentQr': () => Effect.fail(new FinanceRpcModels.FinanceQrUnavailable()),
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        return (...args: any[]) => {
          if (!(prop in calls)) calls[prop] = [];
          calls[prop]?.push(args);
          return fn ? fn(...args) : Effect.void;
        };
      },
    }),
  );

  return { calls, layer };
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: Calls; layer: Layer.Layer<DiscordREST> } => {
  const calls: Calls = {};

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createDm: () => Effect.succeed({ id: DM_CHANNEL_ID }),
    createMessage: () => Effect.succeed({ id: 'msg-1' }),
    getGuild: () => Effect.succeed({ preferred_locale: 'en-US', system_channel_id: null }),
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        return (...args: any[]) => {
          if (!(prop in calls)) calls[prop] = [];
          calls[prop]?.push(args);
          return fn ? fn(...args) : Effect.void;
        };
      },
    }),
  );

  return { calls, layer };
};

const runTick = (rpcLayer: Layer.Layer<SyncRpc>, restLayer: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(
    ProcessorService.pipe(
      Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
      Effect.provide(Layer.merge(rpcLayer, restLayer)),
    ),
  );

describe('finance ProcessorService.processTick', () => {
  it('polls and processes both queues in one tick', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      'Finance/GetUnprocessedPaymentReminders': () => Effect.succeed([reminderEvent]),
      'Finance/GetUnprocessedBankTokenExpiryEvents': () => Effect.succeed([expiryEvent]),
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runTick(rpcLayer, restLayer);

    expect(restCalls.createDm).toHaveLength(2);
    expect(restCalls.createMessage).toHaveLength(2);
    expect(rpcCalls['Finance/MarkPaymentReminderProcessed']).toHaveLength(1);
    expect(rpcCalls['Finance/MarkBankTokenExpiryProcessed']).toHaveLength(1);
  });

  it('marks the bank-token-expiry event failed on a Discord error without breaking the reminder pass', async () => {
    let dmCalls = 0;
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      'Finance/GetUnprocessedPaymentReminders': () => Effect.succeed([reminderEvent]),
      'Finance/GetUnprocessedBankTokenExpiryEvents': () => Effect.succeed([expiryEvent]),
    });
    const { layer: restLayer } = makeRest({
      createDm: () => {
        dmCalls += 1;
        // Fail only the bank-token-expiry DM (2nd createDm call); the reminder's DM (1st) succeeds.
        return dmCalls === 1
          ? Effect.succeed({ id: DM_CHANNEL_ID })
          : Effect.fail(new Error('Discord HTTP 500'));
      },
    });

    await runTick(rpcLayer, restLayer);

    expect(rpcCalls['Finance/MarkPaymentReminderProcessed']).toHaveLength(1);
    expect(rpcCalls['Finance/MarkBankTokenExpiryFailed']).toHaveLength(1);
    expect(rpcCalls['Finance/MarkBankTokenExpiryProcessed']).toBeUndefined();
  });
});
