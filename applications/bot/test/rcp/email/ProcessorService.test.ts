// Tests for Email ProcessorService — handleEmailPostEvent routing via processTick.

import type { Discord, Team } from '@sideline/domain';
import { EmailRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// env mock — WEB_URL toggleable per test
// ---------------------------------------------------------------------------

let mockWebUrl: Option.Option<string> = Option.none();

vi.mock('~/env.js', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (prop === 'WEB_URL') return mockWebUrl;
      return undefined;
    },
  }),
}));

import { ProcessorService } from '~/rcp/email/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-4000-8000-000000000010' as Team.TeamId;
const EMAIL_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-000000000002';
const COACH_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const TARGET_CHANNEL_ID = '222222222222222222' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeEmailPostEvent = (
  kind: EmailRpcEvents.EmailPostEventKind,
  overrides: Partial<{
    id: string;
    summary: string | null;
  }> = {},
): EmailRpcEvents.UnprocessedEmailPostEvent =>
  new EmailRpcEvents.EmailPostEvent({
    id: overrides.id ?? EVENT_ID,
    email_message_id: EMAIL_ID as any,
    team_id: TEAM_ID,
    kind,
    coach_channel_id: COACH_CHANNEL_ID,
    target_channel_id: TARGET_CHANNEL_ID,
    subject: 'Weekly Briefing',
    from_address: 'sender@example.com',
    summary:
      overrides.summary !== undefined
        ? Option.fromNullishOr(overrides.summary)
        : Option.some('AI generated summary text'),
    body: 'Full body text of the email',
    received_at: DateTime.makeUnsafe('2026-01-15T09:00:00.000Z'),
  });

// ---------------------------------------------------------------------------
// SyncRpc mock
// ---------------------------------------------------------------------------

type RpcCalls = {
  GetUnprocessed: unknown[][];
  MarkProcessed: Array<{ id: string; deliveredAt: unknown }>;
  MarkFailed: Array<{ id: string; error: string }>;
};

const makeRpc = (
  events: EmailRpcEvents.UnprocessedEmailPostEvent[] = [],
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = {
    GetUnprocessed: [],
    MarkProcessed: [],
    MarkFailed: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Email/GetUnprocessedEmailPostEvents': (...args: any[]) => {
      calls.GetUnprocessed.push(args);
      return Effect.succeed(events);
    },
    'Email/MarkEmailPostEventProcessed': (args: { id: string; deliveredAt: unknown }) => {
      calls.MarkProcessed.push(args);
      return Effect.void;
    },
    'Email/MarkEmailPostEventFailed': (args: { id: string; error: string }) => {
      calls.MarkFailed.push(args);
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

// ---------------------------------------------------------------------------
// DiscordREST mock
// ---------------------------------------------------------------------------

type RestCalls = {
  createMessage: Array<[string, Record<string, unknown>]>;
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    createMessage: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args as [string, Record<string, unknown>]);
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
// Run helper
// ---------------------------------------------------------------------------

const runProcessTick = (
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
): Promise<void> =>
  Effect.runPromise(
    ProcessorService.pipe(
      Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
      Effect.provide(Layer.merge(rpcLayer, restLayer)),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Email ProcessorService — processTick', () => {
  afterEach(() => {
    mockWebUrl = Option.none();
  });

  it('empty event list → no createMessage, no MarkProcessed, no MarkFailed', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.GetUnprocessed).toHaveLength(1);
    expect(restCalls.createMessage).toHaveLength(0);
    expect(rpcCalls.MarkProcessed).toHaveLength(0);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });

  it('approval_request → createMessage to coach_channel_id, allowed_mentions:{parse:[]}, MarkProcessed called', async () => {
    const event = makeEmailPostEvent('approval_request');
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createMessage).toHaveLength(1);
    const [channelId, body] = restCalls.createMessage[0];
    expect(channelId).toBe(COACH_CHANNEL_ID);
    expect((body as any).allowed_mentions).toEqual({ parse: [] });
    expect(rpcCalls.MarkProcessed).toHaveLength(1);
    expect((rpcCalls.MarkProcessed[0] as any).id).toBe(EVENT_ID);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });

  it('approval_request → embed has approval_request color (amber 0xfee75c)', async () => {
    const event = makeEmailPostEvent('approval_request');
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, body] = restCalls.createMessage[0];
    const embeds = (body as any).embeds as Array<{ color?: number }>;
    expect(embeds).toHaveLength(1);
    expect(embeds[0].color).toBe(0xfee75c);
  });

  it('approval_request — embed has approve + reject buttons with correct custom_ids', async () => {
    const event = makeEmailPostEvent('approval_request');
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, body] = restCalls.createMessage[0];
    const components = (body as any).components as Array<{
      components: Array<{ custom_id?: string }>;
    }>;
    expect(components).toHaveLength(1);
    const buttonIds = components[0].components.map((b) => b.custom_id).filter(Boolean);
    expect(buttonIds).toContain(`email-approve:${TEAM_ID}:${EMAIL_ID}`);
    expect(buttonIds).toContain(`email-reject:${TEAM_ID}:${EMAIL_ID}`);
  });

  it('post_summary → createMessage to target_channel_id, allowed_mentions:{parse:[]}, MarkProcessed called', async () => {
    const event = makeEmailPostEvent('post_summary');
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createMessage).toHaveLength(1);
    const [channelId, body] = restCalls.createMessage[0];
    expect(channelId).toBe(TARGET_CHANNEL_ID);
    expect((body as any).allowed_mentions).toEqual({ parse: [] });
    expect(rpcCalls.MarkProcessed).toHaveLength(1);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });

  it('post_summary → embed has green color (0x57f287)', async () => {
    const event = makeEmailPostEvent('post_summary');
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, body] = restCalls.createMessage[0];
    const embeds = (body as any).embeds as Array<{ color?: number }>;
    expect(embeds[0].color).toBe(0x57f287);
  });

  it('post_original → createMessage to target_channel_id, allowed_mentions:{parse:[]}, MarkProcessed called', async () => {
    const event = makeEmailPostEvent('post_original');
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createMessage).toHaveLength(1);
    const [channelId, body] = restCalls.createMessage[0];
    expect(channelId).toBe(TARGET_CHANNEL_ID);
    expect((body as any).allowed_mentions).toEqual({ parse: [] });
    expect(rpcCalls.MarkProcessed).toHaveLength(1);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });

  it('post_original → embed has grey color (0x99aab5)', async () => {
    const event = makeEmailPostEvent('post_original');
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, body] = restCalls.createMessage[0];
    const embeds = (body as any).embeds as Array<{ color?: number }>;
    expect(embeds[0].color).toBe(0x99aab5);
  });

  it('WEB_URL set → approval_request embed includes deep link button with correct URL', async () => {
    mockWebUrl = Option.some('https://sideline.app');
    const event = makeEmailPostEvent('approval_request');
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, body] = restCalls.createMessage[0];
    const components = (body as any).components as Array<{
      components: Array<{ url?: string; style?: number }>;
    }>;
    const linkButtons = components[0].components.filter((b) => b.style === 5);
    expect(linkButtons).toHaveLength(1);
    expect(linkButtons[0].url).toBe(`https://sideline.app/teams/${TEAM_ID}/emails/${EMAIL_ID}`);
  });

  it('WEB_URL not set → post_summary has no link button (components undefined)', async () => {
    mockWebUrl = Option.none();
    const event = makeEmailPostEvent('post_summary');
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, body] = restCalls.createMessage[0];
    // When there are no deep-link components, components is undefined (not set)
    expect((body as any).components).toBeUndefined();
  });

  it('WEB_URL set → post_summary embed includes view link button', async () => {
    mockWebUrl = Option.some('https://sideline.app');
    const event = makeEmailPostEvent('post_summary');
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, body] = restCalls.createMessage[0];
    const components = (body as any).components as Array<{
      components: Array<{ url?: string; style?: number }>;
    }>;
    expect(components).toHaveLength(1);
    const linkButton = components[0].components.find((b) => b.style === 5);
    expect(linkButton?.url).toBe(`https://sideline.app/teams/${TEAM_ID}/emails/${EMAIL_ID}`);
  });

  it('createMessage throws Discord error → MarkEmailPostEventFailed called with error', async () => {
    const event = makeEmailPostEvent('approval_request');
    const discordError = new Error('Discord API unavailable');
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      createMessage: () => Effect.fail(discordError as any),
    });

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createMessage).toHaveLength(0); // proxy won't record — effect fails
    expect(rpcCalls.MarkProcessed).toHaveLength(0);
    expect(rpcCalls.MarkFailed).toHaveLength(1);
    const failCall = rpcCalls.MarkFailed[0];
    expect(failCall.id).toBe(EVENT_ID);
    expect(typeof failCall.error).toBe('string');
  });

  it('batch of 2 events → each processed independently, MarkProcessed called for both', async () => {
    const event1 = makeEmailPostEvent('approval_request', {
      id: '00000000-0000-4000-8000-000000000011',
    });
    const event2 = makeEmailPostEvent('post_summary', {
      id: '00000000-0000-4000-8000-000000000012',
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event1, event2]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createMessage).toHaveLength(2);
    // event1: approval_request → coach channel
    expect(restCalls.createMessage[0][0]).toBe(COACH_CHANNEL_ID);
    // event2: post_summary → target channel
    expect(restCalls.createMessage[1][0]).toBe(TARGET_CHANNEL_ID);
    expect(rpcCalls.MarkProcessed).toHaveLength(2);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });
});
