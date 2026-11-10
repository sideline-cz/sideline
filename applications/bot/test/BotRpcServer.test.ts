import { createServer } from 'node:http';
import { NodeHttpServer } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { BotRpcs } from '@sideline/domain';
import { DiscordGateway } from 'dfx/gateway';
import { Effect, Layer, Redacted } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc';
import { makeBotRpcServer } from '~/BotRpcServerLive.js';
import { BotHealthApi } from '~/HealthServerLive.js';
import { APP_VERSION } from '~/version.js';

const SECRET = Redacted.make('s3cret');

// Same protocol shape as the server client: prependUrl + bearerToken + filterStatusOk.
const ping = (client: HttpClient.HttpClient, token: string, url = '') =>
  RpcClient.make(BotRpcs.BotRpcs).pipe(
    Effect.flatMap((rpc) => rpc['Bot/Ping']()),
    Effect.provideServiceEffect(
      RpcClient.Protocol,
      RpcClient.makeProtocolHttp(
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(url)),
          HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
          HttpClient.filterStatusOk,
        ),
      ),
    ),
    Effect.provide(RpcSerialization.layerNdjson),
    Effect.scoped,
  );

const TestServer = makeBotRpcServer(SECRET).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

describe('BotRpcServer', () => {
  it.live('ping with the correct secret returns the bot version', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const result = yield* ping(client, 's3cret');
      expect(result).toEqual({ version: APP_VERSION });
    }).pipe(Effect.provide(TestServer)),
  );

  it.live('request without a secret is rejected', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.post('/');
      expect(response.status).toBe(401);
    }).pipe(Effect.provide(TestServer)),
  );

  it.live(
    'client with a wrong secret fails fast',
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const error = yield* Effect.flip(ping(client, 'wrong'));
        expect(error._tag).toBe('RpcClientError');
      }).pipe(Effect.provide(TestServer)),
    2000,
  );

  it.live('RPC does not answer on the health port', () => {
    // Copy of the mock gateway in test/health.test.ts.
    const MockGateway = Layer.succeed(DiscordGateway, {
      [DiscordGateway.key]: DiscordGateway.key,
      dispatch: undefined as never,
      fromDispatch: undefined as never,
      handleDispatch: undefined as never,
      send: undefined as never,
      shards: Effect.succeed(new Set()),
    } as never);

    const HealthGroupLive = HttpApiBuilder.group(BotHealthApi, 'health', (handlers) =>
      Effect.succeed(
        handlers
          .handle('healthCheck', () => Effect.succeed({ status: 'ok' as const, shards: 0 }))
          .handle('healthz', () => Effect.succeed({ status: 'ok' as const }))
          .handle('info', () =>
            Effect.succeed({ version: 'dev', commit: 'unknown', build_time: null }),
          ),
      ),
    );

    // Built the same way as HealthServerLive, in the SAME graph as the RPC server.
    const HealthLive = HttpRouter.serve(
      HttpApiBuilder.layer(BotHealthApi).pipe(Layer.provide(HealthGroupLive)),
    ).pipe(
      Layer.provide(MockGateway),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
    );
    const RpcLive = makeBotRpcServer(SECRET).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: 0 })),
    );

    return Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const port = server.address._tag === 'TcpAddress' ? server.address.port : 0;
      const healthUrl = `http://127.0.0.1:${port}`;
      const client = yield* HttpClient.HttpClient;

      // Several paths: a mount at '/rpc' would answer there, not at '/'.
      for (const path of ['', '/rpc', '/rpc/bot']) {
        const error = yield* Effect.flip(ping(client, 's3cret', `${healthUrl}${path}`));
        expect(error._tag).toBe('RpcClientError');
      }

      const healthz = yield* client.get(`${healthUrl}/healthz`);
      expect(healthz.status).toBe(200);
    }).pipe(Effect.provide(Layer.mergeAll(HealthLive, RpcLive, FetchHttpClient.layer)));
  });
});
