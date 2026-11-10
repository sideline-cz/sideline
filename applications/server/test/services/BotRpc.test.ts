import { createServer } from 'node:http';
import { NodeHttpServer } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { BotRpcs } from '@sideline/domain';
import { Effect, Layer, Option, Redacted } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { BotRpc, BotRpcUnavailable } from '~/services/BotRpc.js';

// In-process bot stand-in, built from the shared contract with a test-local 401 check.
const botStandIn = (handler: () => Effect.Effect<BotRpcs.PingResult>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const app = yield* RpcServer.toHttpEffect(BotRpcs.BotRpcs);
      // `HttpServer.serve` runs the handler uninterruptibly (`HttpRouter` adds this itself).
      // Without it a client abort never stops `Effect.never`, and teardown hangs.
      return HttpServer.serve(
        Effect.interruptible(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.headers.authorization !== 'Bearer s3cret') {
              return HttpServerResponse.empty({ status: 401 });
            }
            return yield* app;
          }),
        ),
      );
    }),
  ).pipe(
    Layer.provide(BotRpcs.BotRpcs.toLayer({ 'Bot/Ping': handler })),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
  );

// A server that answers 200 with a body that is not NDJSON. The newline matters: the NDJSON
// parser only reads complete lines, so a body with no newline gives zero frames and `timeout`.
const notNdjsonStandIn = HttpServer.serve(
  Effect.succeed(HttpServerResponse.text('not json\n', { status: 200 })),
).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })));

const pingWith = (options: { url: Option.Option<string>; secret?: string | undefined }) =>
  BotRpc.asEffect().pipe(
    Effect.flatMap((botRpc) => botRpc.ping),
    Effect.provide(
      BotRpc.layer({
        url: options.url,
        secret: Option.some(Redacted.make(options.secret ?? 's3cret')),
        timeout: '200 millis',
      }),
    ),
  );

// Pings the stand-in that is running in the current scope.
const pingStandIn = (secret?: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const port = server.address._tag === 'TcpAddress' ? server.address.port : 0;
    return yield* pingWith({ url: Option.some(`http://127.0.0.1:${port}`), secret });
  });

const expectReason = (error: unknown, reason: BotRpcUnavailable['reason']) => {
  expect(error).toBeInstanceOf(BotRpcUnavailable);
  expect((error as BotRpcUnavailable).reason).toBe(reason);
};

describe('BotRpc', () => {
  it.live('ping returns the typed answer', () =>
    pingStandIn().pipe(
      Effect.map((result) => expect(result).toEqual({ version: 'test-bot' })),
      Effect.provide(botStandIn(() => Effect.succeed({ version: 'test-bot' }))),
    ),
  );

  it.live(
    'wrong secret maps to transport',
    () =>
      Effect.flip(pingStandIn('wrong')).pipe(
        Effect.map((error) => expectReason(error, 'transport')),
        Effect.provide(botStandIn(() => Effect.succeed({ version: 'test-bot' }))),
      ),
    2000,
  );

  it.live(
    'slow bot maps to timeout',
    () =>
      Effect.flip(pingStandIn()).pipe(
        Effect.map((error) => expectReason(error, 'timeout')),
        Effect.provide(botStandIn(() => Effect.never)),
      ),
    2000,
  );

  it.live('unreachable bot maps to transport', () =>
    Effect.flip(pingWith({ url: Option.some('http://127.0.0.1:1') })).pipe(
      Effect.map((error) => expectReason(error, 'transport')),
    ),
  );

  it.live('missing config maps to not_configured', () =>
    Effect.flip(pingWith({ url: Option.none() })).pipe(
      Effect.map((error) => expectReason(error, 'not_configured')),
    ),
  );

  it.live(
    '200 with a body that is not NDJSON maps to transport',
    () =>
      Effect.flip(pingStandIn()).pipe(
        Effect.map((error) => expectReason(error, 'transport')),
        Effect.provide(notNdjsonStandIn),
      ),
    2000,
  );
});
