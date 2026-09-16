import type { Team } from '@sideline/domain';
import { type Discord, FinanceRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleBankTokenExpiring } from '~/rcp/finance/handleBankTokenExpiring.js';

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;
const DM_CHANNEL_ID = '333333333333333333' as Discord.Snowflake;

const makeEvent = (daysUntilExpiry = 14) =>
  new FinanceRpcEvents.BankTokenExpiringEvent({
    id: '00000000-0000-0000-0000-000000000002',
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    user_discord_id: DISCORD_USER_ID,
    days_until_expiry: daysUntilExpiry,
  });

type RestCallRecord = { createDm: unknown[][]; createMessage: unknown[][]; getGuild: unknown[][] };

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = { createDm: [], createMessage: [], getGuild: [] };

  const defaults: Record<string, (...args: any[]) => any> = {
    createDm: (...args: any[]) => {
      calls.createDm.push(args);
      return Effect.succeed({ id: DM_CHANNEL_ID });
    },
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args);
      return Effect.succeed({ id: 'msg-123' });
    },
    getGuild: (...args: any[]) => {
      calls.getGuild.push(args);
      return Effect.succeed({ preferred_locale: 'cs', system_channel_id: null });
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

const run = (event: FinanceRpcEvents.BankTokenExpiringEvent, restLayer: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(handleBankTokenExpiring(event).pipe(Effect.provide(restLayer)));

describe('handleBankTokenExpiring', () => {
  it('DMs the treasurer with the days-until-expiry title', async () => {
    const { calls, layer } = makeRest();

    await run(makeEvent(7), layer);

    expect(calls.createDm).toHaveLength(1);
    expect(calls.createDm[0]?.[0]).toMatchObject({ recipient_id: DISCORD_USER_ID });
    expect(calls.createMessage).toHaveLength(1);
    const [channelId, body] = calls.createMessage[0] as [string, { embeds?: any[] }];
    expect(channelId).toBe(DM_CHANNEL_ID);
    expect(JSON.stringify(body)).toContain('Token k bance vyprší za 7 dní');
  });

  it('propagates a Discord createMessage failure', async () => {
    const { layer } = makeRest({
      createMessage: () => Effect.fail(new Error('Discord HTTP 500')),
    });

    await expect(run(makeEvent(), layer)).rejects.toThrow();
  });
});
