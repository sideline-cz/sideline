// discordRead ProcessorService — poll `DiscordRead/GetUnprocessedRequests`, read the channel
// through `fetchChannelMessages`, write every outcome back with `DiscordRead/SubmitResult`.
// Harness: `test/rcp/inviteGenerator/ProcessorService.test.ts`, but both doubles record in the
// proxy, not in the defaults (bot AGENTS.md "makeRest Proxy Doubles").

import { DiscordReadRequest } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option, type ServiceMap } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProcessorService } from '~/rcp/discordRead/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';

type Fn = (...args: any[]) => Effect.Effect<any, any, any>;

interface Request {
  readonly id: string;
  readonly channel_id: string;
  readonly since: Option.Option<DateTime.Utc>;
  readonly limit: number;
}

const CHANNEL_ID = '222222222222222222';

const request = (overrides: Partial<Request> = {}): Request => ({
  id: '00000000-0000-1000-8000-000000000001',
  channel_id: CHANNEL_ID,
  since: Option.none(),
  limit: 50,
  ...overrides,
});

const makeProxy = <I, S>(
  tag: ServiceMap.Service<I, S>,
  defaults: Record<string, Fn>,
  overrides: Record<string, Fn>,
  calls: Record<string, unknown[][]>,
) =>
  Layer.succeed(
    tag as any,
    new Proxy({} as any, {
      get: (_t: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) throw new Error(`Unmocked method: ${prop}`);
        return (...args: any[]) => {
          const list = calls[prop] ?? [];
          calls[prop] = list;
          list.push(args);
          return fn(...args);
        };
      },
    }),
  ) as Layer.Layer<I>;

const run = (opts: {
  readonly requests: ReadonlyArray<Request>;
  readonly rpc?: Record<string, Fn>;
  readonly rest?: Record<string, Fn>;
}) => {
  const calls: Record<string, unknown[][]> = {};
  const rpc = makeProxy(
    SyncRpc,
    {
      'DiscordRead/GetUnprocessedRequests': () => Effect.succeed(opts.requests),
      'DiscordRead/SubmitResult': () => Effect.void,
    },
    opts.rpc ?? {},
    calls,
  );
  const rest = makeProxy(
    DiscordREST,
    { listMessages: () => Effect.succeed([]) },
    opts.rest ?? {},
    calls,
  );
  return Effect.runPromise(
    ProcessorService.pipe(
      Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
      Effect.provide(Layer.merge(rpc, rest)),
    ),
  ).then(() => ({
    calls,
    submitted: (calls['DiscordRead/SubmitResult'] ?? []).map(
      (args) => args[0] as { id: string; result: DiscordReadRequest.DiscordReadResult },
    ),
  }));
};

let seq = 0;
/** A Discord message; `minutesAgo` drives the timestamp (pages are newest first). */
const msg = (opts: {
  readonly content?: string;
  readonly bot?: boolean;
  readonly minutesAgo?: number;
  readonly mentions?: ReadonlyArray<unknown>;
  readonly name?: string;
}) => {
  seq += 1;
  return {
    id: String(900000000000000000n + BigInt(seq)),
    content: opts.content ?? `message ${String(seq)}`,
    timestamp: new Date(Date.now() - (opts.minutesAgo ?? 1) * 60_000).toISOString(),
    author: {
      id: String(800000000000000000n + BigInt(seq)),
      username: `user${String(seq)}`,
      global_name: opts.bot ? null : (opts.name ?? `User ${String(seq)}`),
      bot: opts.bot ?? false,
    },
    mentions: opts.mentions ?? [],
  };
};

const page = (n: number, botEvery: (i: number) => boolean = () => false) =>
  Array.from({ length: n }, (_, i) => msg({ minutesAgo: 1 + i / 10, bot: botEvery(i) }));

describe('discordRead ProcessorService — processTick', () => {
  it('ok: drops bot messages, keeps empty content, oldest first, display names only', async () => {
    const newest = msg({ content: 'newest', minutesAgo: 1 });
    const bot = msg({ content: 'beep', minutesAgo: 2, bot: true });
    const empty = msg({ content: '', minutesAgo: 3 });
    const { submitted } = await run({
      requests: [request()],
      rest: { listMessages: () => Effect.succeed([newest, bot, empty]) },
    });

    expect(submitted).toHaveLength(1);
    const result = submitted[0]?.result;
    expect(result).toMatchObject({ outcome: 'ok', capped: false });
    expect(result?.messages.map((m) => m.content)).toEqual(['', 'newest']);
    expect(result?.messages[1]?.author).toBe(newest.author.global_name);
    const json = JSON.stringify(result);
    expect(json).not.toContain(newest.author.id);
    expect(json).not.toContain(empty.author.id);
  });

  it('page cap: a since window that fills two pages stops paging and is capped', async () => {
    const since = Option.some(DateTime.makeUnsafe(Date.now() - 60 * 60_000));
    const { calls, submitted } = await run({
      requests: [request({ since })],
      rest: { listMessages: () => Effect.succeed(page(100)) },
    });

    expect(calls.listMessages).toHaveLength(2);
    expect(submitted[0]?.result.capped).toBe(true);
  });

  for (const [label, error, outcome] of [
    [
      '403',
      { _tag: 'ErrorResponse', response: { status: 403 }, data: { code: 50001 } },
      'no_access',
    ],
    [
      '404 Unknown Channel',
      { _tag: 'ErrorResponse', response: { status: 404 }, data: { code: 10003 } },
      'channel_missing',
    ],
    ['500', { _tag: 'HttpClientError', response: { status: 500 } }, 'discord_error'],
  ] as const) {
    it(`a Discord ${label} is written back as ${outcome}`, async () => {
      const { submitted } = await run({
        requests: [request()],
        rest: { listMessages: () => Effect.fail(error) },
      });

      expect(submitted.map((s) => s.result)).toEqual([{ outcome, messages: [], capped: false }]);
    });
  }

  it('a failed SubmitResult does not stop the tick: the next request is still served', async () => {
    let submits = 0;
    const second = request({ id: '00000000-0000-1000-8000-000000000002' });
    const { calls } = await run({
      requests: [request(), second],
      rpc: {
        'DiscordRead/SubmitResult': () => {
          submits += 1;
          return submits === 1
            ? Effect.fail({ _tag: 'RpcClientError', message: 'down' })
            : Effect.void;
        },
      },
    });

    expect(calls.listMessages).toHaveLength(2);
    const ids = (calls['DiscordRead/SubmitResult'] ?? []).map((a) => (a[0] as { id: string }).id);
    expect(ids).toEqual([request().id, second.id]);
  });

  it('an empty poll does not touch Discord', async () => {
    const { calls } = await run({ requests: [] });
    expect(calls.listMessages ?? []).toHaveLength(0);
  });

  it('bot messages that eat the window mark it capped; reaching channel start does not', async () => {
    const full = await run({
      requests: [request()],
      rest: { listMessages: () => Effect.succeed(page(100, (i) => i % 10 !== 0)) },
    });
    expect(full.submitted[0]?.result.capped).toBe(true);

    const short = await run({
      requests: [request()],
      rest: { listMessages: () => Effect.succeed(page(30, (i) => i < 20)) },
    });
    expect(short.submitted[0]?.result.messages).toHaveLength(10);
    expect(short.submitted[0]?.result.capped).toBe(false);
  });

  it('size cap: drops the oldest messages to fit the budget and marks it capped', async () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ content: `${String(i).padStart(3, '0')}${'x'.repeat(297)}`, minutesAgo: i + 1 }),
    );
    const { submitted } = await run({
      requests: [request()],
      rest: { listMessages: () => Effect.succeed(messages) },
    });

    const result = submitted[0]?.result;
    expect(JSON.stringify(result?.messages).length).toBeLessThanOrEqual(
      DiscordReadRequest.READ_RESULT_CHAR_BUDGET,
    );
    expect(result?.capped).toBe(true);
    expect(result?.messages.at(-1)?.content).toBe(messages[0]?.content);
    expect(result?.messages.map((m) => m.content)).not.toContain(messages[39]?.content);
  });

  it('size cap: a newest message over the budget alone is cut, not dropped', async () => {
    const { submitted } = await run({
      requests: [request()],
      rest: { listMessages: () => Effect.succeed([msg({ content: '"'.repeat(6000) })]) },
    });

    const result = submitted[0]?.result;
    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0]?.content.endsWith('…')).toBe(true);
    expect(JSON.stringify(result?.messages).length).toBeLessThanOrEqual(
      DiscordReadRequest.READ_RESULT_CHAR_BUDGET,
    );
    expect(result?.capped).toBe(true);
  });

  it('mention tokens and message links become names, never raw ids', async () => {
    const m = msg({
      content:
        'hi <@111> see <#222> and <@&333> <:wave:444> <@999> </standings:555> https://discord.com/channels/1/2/3',
      mentions: [{ id: '111', username: 'ann', global_name: null }],
      name: 'Ann',
    });
    const { submitted } = await run({
      requests: [request()],
      rest: { listMessages: () => Effect.succeed([m]) },
    });

    const messages = submitted[0]?.result.messages ?? [];
    expect(messages[0]?.content).toBe(
      'hi @ann see #channel and @role :wave: @someone /standings [Discord link]',
    );
    const text = JSON.stringify(messages.map(({ author, content }) => ({ author, content })));
    expect(text).not.toMatch(/\d{3,}/);
  });
});
