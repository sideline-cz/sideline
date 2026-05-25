// Tests for WeeklyChallenge ProcessorService — processTick behavior.
// Bot-side ProcessorService is stateless w.r.t. attempt counting; the server
// query already filters attempts < 5 before returning events.

import {
  type Discord,
  type Team,
  type WeeklyChallenge,
  WeeklyChallengeSyncEvents,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Logger, Option } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// env mock — allows per-test WEB_URL toggling without bypassing schema.
// vi.mock is hoisted before imports, so the factory runs before ProcessorService
// is evaluated; the mutable `mockWebUrl` ref lets individual tests set the value.
// ---------------------------------------------------------------------------

// Mutable ref shared between the vi.mock factory and the test helpers.
let mockWebUrl: Option.Option<string> = Option.none();

vi.mock('~/env.js', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (prop === 'WEB_URL') return mockWebUrl;
      return undefined;
    },
  }),
}));

import { ProcessorService } from '~/rcp/weeklyChallenge/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-4000-8000-000000000010' as Team.TeamId;
const CHALLENGE_ID = 'chal-001' as WeeklyChallenge.WeeklyChallengeId;
const CHANNEL_ID = '333333333333333333' as Discord.Snowflake;
const EVENT_ID = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeEvent = (
  overrides: Partial<{
    kind: 'throwing' | 'sport';
    id: string;
    channelId: Discord.Snowflake;
    teamId: Team.TeamId;
  }> = {},
): WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent =>
  new WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent({
    id: overrides.id ?? EVENT_ID,
    teamId: overrides.teamId ?? TEAM_ID,
    challengeId: CHALLENGE_ID,
    channelId: overrides.channelId ?? CHANNEL_ID,
    scheduledFor: DateTime.makeUnsafe('2026-03-10T08:00:00.000Z'),
    attempts: 0,
    title: 'Test Challenge Title' as WeeklyChallenge.WeeklyChallengeTitle,
    kind: overrides.kind ?? 'throwing',
    description: Option.none(),
    weekStartDate: '2026-03-09',
    weekEndDate: '2026-03-15',
  });

// ---------------------------------------------------------------------------
// SyncRpc mock helpers
// ---------------------------------------------------------------------------

type RpcCalls = {
  GetUnprocessed: unknown[][];
  MarkProcessed: unknown[][];
  MarkFailed: unknown[][];
};

const makeRpc = (
  events: WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent[] = [],
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = {
    GetUnprocessed: [],
    MarkProcessed: [],
    MarkFailed: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents': (...args: any[]) => {
      calls.GetUnprocessed.push(args);
      return Effect.succeed(events);
    },
    'WeeklyChallenge/MarkWeeklyChallengeProcessed': (args: any) => {
      calls.MarkProcessed.push(args);
      return Effect.void;
    },
    'WeeklyChallenge/MarkWeeklyChallengeFailed': (args: any) => {
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
// DiscordREST mock helpers
// ---------------------------------------------------------------------------

type RestCalls = {
  createMessage: unknown[][];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    createMessage: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
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
// Fake ErrorResponse factory
// ---------------------------------------------------------------------------

const makeErrorResponse = (status: number, code?: number) =>
  ({
    _tag: 'ErrorResponse',
    response: { status },
    ...(code !== undefined ? { code } : {}),
  }) as any;

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------

const makeLogCapture = (): { messages: string[]; layer: Layer.Layer<never> } => {
  const messages: string[] = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      messages.push(String(options.message));
    }),
  ]);
  return { messages, layer };
};

// ---------------------------------------------------------------------------
// Run helper
// ---------------------------------------------------------------------------

const runProcessTick = (
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
  extraLayer?: Layer.Layer<never>,
) => {
  const base = ProcessorService.pipe(
    Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
    Effect.provide(Layer.merge(rpcLayer, restLayer)),
  );
  return Effect.runPromise(extraLayer ? base.pipe(Effect.provide(extraLayer)) : base);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WeeklyChallenge ProcessorService — processTick', () => {
  afterEach(() => {
    mockWebUrl = Option.none();
  });

  it('empty event list → no Discord createMessage, no MarkProcessed, no MarkFailed, polling happened', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.GetUnprocessed.length).toBe(1);
    expect(restCalls.createMessage).toHaveLength(0);
    expect(rpcCalls.MarkProcessed).toHaveLength(0);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });

  it('happy path — kind=throwing → createMessage called on channelId, embed has color 0x10b981', async () => {
    const event = makeEvent({ kind: 'throwing' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createMessage).toHaveLength(1);
    const [channelArg, messageBody] = restCalls.createMessage[0] as [string, { embeds?: any[] }];
    expect(channelArg).toBe(CHANNEL_ID);
    expect(messageBody.embeds).toHaveLength(1);
    expect(messageBody.embeds?.[0].color).toBe(0x10b981);
    expect(messageBody.embeds?.[0].title).toMatch(/^🥏 /);
    expect(rpcCalls.MarkProcessed).toHaveLength(1);
    expect((rpcCalls.MarkProcessed[0] as any).eventId).toBe(EVENT_ID);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });

  it('happy path — kind=sport → createMessage called on channelId, embed has color 0xf59e0b', async () => {
    const event = makeEvent({ kind: 'sport' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(restCalls.createMessage).toHaveLength(1);
    const [, messageBody] = restCalls.createMessage[0] as [string, { embeds?: any[] }];
    expect(messageBody.embeds?.[0].color).toBe(0xf59e0b);
    expect(messageBody.embeds?.[0].title).toMatch(/^🏃 /);
    expect(rpcCalls.MarkProcessed).toHaveLength(1);
    expect(rpcCalls.MarkFailed).toHaveLength(0);
  });

  it('WEB_URL env present → embed.url is /teams/{teamId}/challenges', async () => {
    mockWebUrl = Option.some('https://app.example.com');

    const event = makeEvent({ kind: 'throwing' });
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, messageBody] = restCalls.createMessage[0] as [string, { embeds?: any[] }];
    const embedUrl: string | undefined = messageBody.embeds?.[0].url;
    expect(embedUrl).toBeDefined();
    expect(embedUrl).toBe(`https://app.example.com/teams/${TEAM_ID}/challenges`);
  });

  it('WEB_URL env absent → embed has no url field', async () => {
    // mockWebUrl defaults to Option.none() (reset in afterEach); no setup needed.
    const event = makeEvent({ kind: 'throwing' });
    const { layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    const [, messageBody] = restCalls.createMessage[0] as [string, { embeds?: any[] }];
    expect(messageBody.embeds?.[0].url).toBeUndefined();
  });

  it('Discord createMessage returns 404 ErrorResponse → MarkProcessed called (short-circuit, row marked done), MarkFailed NOT called, tick does not crash, log contains 404', async () => {
    // 404 means the channel was deleted. Handler short-circuits (returns void),
    // so outer Effect.catchAll in ProcessorService does NOT fire → MarkProcessed.
    const event = makeEvent({ kind: 'throwing' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { messages, layer: logLayer } = makeLogCapture();
    const { calls: restCalls, layer: restLayer } = makeRest({
      createMessage: (...args: any[]) => {
        restCalls.createMessage.push(args);
        return Effect.fail(makeErrorResponse(404));
      },
    });

    // Must NOT throw
    await expect(runProcessTick(rpcLayer, restLayer, logLayer)).resolves.not.toThrow();

    expect(restCalls.createMessage).toHaveLength(1);
    expect(rpcCalls.MarkProcessed).toHaveLength(1);
    expect((rpcCalls.MarkProcessed[0] as any).eventId).toBe(EVENT_ID);
    expect(rpcCalls.MarkFailed).toHaveLength(0);

    // Short-circuit branch must emit a log line containing the 404 status and channelId
    const logWith404 = messages.filter((m) => m.includes('404'));
    expect(logWith404.length).toBeGreaterThan(0);
    expect(logWith404.some((m) => m.includes(CHANNEL_ID))).toBe(true);
  });

  it('Discord createMessage returns 403/50001 (Missing Access) → MarkFailed called with eventId + error string, MarkProcessed NOT called, tick does not crash', async () => {
    // 50001 / Missing Access: retry policy fires (exponential, recur 3 → 4 attempts total),
    // then outer Effect.catchAll → MarkFailed.
    const event = makeEvent({ kind: 'throwing' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      createMessage: (...args: any[]) => {
        restCalls.createMessage.push(args);
        return Effect.fail(makeErrorResponse(403, 50001));
      },
    });

    // Must NOT throw (ProcessorService catches and calls MarkFailed)
    await expect(runProcessTick(rpcLayer, restLayer)).resolves.not.toThrow();

    // Retry policy: Schedule.exponential('1 second').pipe(Schedule.both(Schedule.recurs(3)))
    // → initial attempt + 3 retries = exactly 4 total calls
    expect(restCalls.createMessage.length).toBe(4);
    expect(rpcCalls.MarkFailed).toHaveLength(1);
    const failCall = rpcCalls.MarkFailed[0] as any;
    expect(failCall.eventId).toBe(EVENT_ID);
    expect(typeof failCall.error).toBe('string');
    expect(failCall.error).toMatch(/50001|403/);
    expect(rpcCalls.MarkProcessed).toHaveLength(0);
  }, 15_000);

  it('Discord createMessage returns 403/50013 (Missing Permissions) → MarkFailed called, MarkProcessed NOT called, tick does not crash', async () => {
    // Same shape as 50001 but with code 50013.
    const event = makeEvent({ kind: 'throwing' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      createMessage: (...args: any[]) => {
        restCalls.createMessage.push(args);
        return Effect.fail(makeErrorResponse(403, 50013));
      },
    });

    await expect(runProcessTick(rpcLayer, restLayer)).resolves.not.toThrow();

    // Retry policy: exactly 4 attempts (initial + 3 retries)
    expect(restCalls.createMessage.length).toBe(4);
    expect(rpcCalls.MarkFailed).toHaveLength(1);
    const failCall = rpcCalls.MarkFailed[0] as any;
    expect(failCall.eventId).toBe(EVENT_ID);
    expect(typeof failCall.error).toBe('string');
    expect(failCall.error).toMatch(/50013|403/);
    expect(rpcCalls.MarkProcessed).toHaveLength(0);
  }, 15_000);

  it('MarkWeeklyChallengeProcessed receives a deliveredAt DateTime.Utc value close to now', async () => {
    const beforeMs = Date.now();
    const event = makeEvent({ kind: 'throwing' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { layer: restLayer } = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(rpcCalls.MarkProcessed).toHaveLength(1);
    const call = rpcCalls.MarkProcessed[0] as any;
    // deliveredAt should be a DateTime.Utc (has epochMilliseconds)
    expect(call.deliveredAt).toBeDefined();
    // epochMilliseconds is a number in Effect 4 beta (was bigint in earlier versions)
    expect(typeof call.deliveredAt.epochMilliseconds).toMatch(/^(number|bigint)$/);
    // deliveredAt must be within 5 seconds of when the test started
    const deliveredAtMs = Number(call.deliveredAt.epochMilliseconds);
    expect(deliveredAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(deliveredAtMs).toBeLessThanOrEqual(beforeMs + 5_000);
  });

  // ---------------------------------------------------------------------------
  // formatError coverage — branches not reachable via ErrorResponse
  // ---------------------------------------------------------------------------

  it('formatError: object with _tag but no response property → MarkFailed.error contains tag and JSON body', async () => {
    // Simulate an RpcClientError-like object that has _tag but no .response.
    // This exercises the `${tag}: ${JSON.stringify(err)}` branch inside formatError.
    const rpcLikeError = { _tag: 'RpcClientError', message: 'connection refused' };
    const event = makeEvent({ kind: 'throwing' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      createMessage: (...args: any[]) => {
        restCalls.createMessage.push(args);
        return Effect.fail(rpcLikeError as any);
      },
    });

    await expect(runProcessTick(rpcLayer, restLayer)).resolves.not.toThrow();

    expect(rpcCalls.MarkFailed).toHaveLength(1);
    const failCall = rpcCalls.MarkFailed[0] as any;
    expect(typeof failCall.error).toBe('string');
    // Must mention the _tag
    expect(failCall.error).toContain('RpcClientError');
    // Must NOT be just "undefined" or empty
    expect(failCall.error.length).toBeGreaterThan(0);
  }, 15_000);

  it('formatError: primitive string error → MarkFailed.error is the plain string', async () => {
    // Exercises the final `return String(err)` branch inside formatError
    // when the thrown value is a plain string (not an object).
    const event = makeEvent({ kind: 'throwing' });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc([event]);
    const { calls: restCalls, layer: restLayer } = makeRest({
      createMessage: (...args: any[]) => {
        restCalls.createMessage.push(args);
        return Effect.fail('something went wrong' as any);
      },
    });

    await expect(runProcessTick(rpcLayer, restLayer)).resolves.not.toThrow();

    expect(rpcCalls.MarkFailed).toHaveLength(1);
    const failCall = rpcCalls.MarkFailed[0] as any;
    expect(failCall.error).toBe('something went wrong');
  }, 15_000);
});
