import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { NodeHttpServer } from '@effect/platform-node';
import { BotRpcs } from '@sideline/domain';
import { Effect, Layer, Option, Redacted } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { env } from '~/env.js';
import { APP_VERSION } from '~/version.js';

// The whole port is RPC. Never the health port: see AGENTS.md (shared-router trap).
const BOT_RPC_PORT = 9100;

// A future handler that needs DiscordREST or a cache MUST bind it in an Effect.Do deps block
// before `toLayer` (reference: applications/server/src/rpc/botInfo/index.ts). Never acquire a
// service inside the handler body, or R leaks into run.ts. Bundle binds near 19.
const HandlersLive = BotRpcs.BotRpcs.toLayer({
  'Bot/Ping': () => Effect.succeed({ version: APP_VERSION }),
});

const sha256 = (value: string) => createHash('sha256').update(value).digest();

// Hashing gives equal-length buffers, so timingSafeEqual never throws.
const isAuthorized = (header: string | undefined, secret: Redacted.Redacted<string>) =>
  header !== undefined &&
  timingSafeEqual(sha256(header), sha256(`Bearer ${Redacted.value(secret)}`));

export const makeBotRpcServer = (secret: Redacted.Redacted<string>) =>
  Layer.unwrap(
    RpcServer.toHttpEffect(BotRpcs.BotRpcs).pipe(
      Effect.map((app) =>
        HttpServer.serve(
          HttpServerRequest.HttpServerRequest.asEffect().pipe(
            Effect.flatMap((request) =>
              isAuthorized(request.headers.authorization, secret)
                ? app
                : Effect.succeed(HttpServerResponse.empty({ status: 401 })),
            ),
            // Raw HttpServer.serve runs handlers uninterruptibly (HttpRouter adds this itself).
            // Without it a client timeout never stops the handler and shutdown can hang.
            Effect.interruptible,
          ),
        ),
      ),
      Effect.provide(Layer.merge(HandlersLive, RpcSerialization.layerNdjson)),
    ),
  );

export const BotRpcServerLive = Option.match(env.BOT_RPC_SECRET, {
  onNone: () =>
    Layer.effectDiscard(Effect.logWarning('BOT_RPC_SECRET unset — bot RPC server disabled')),
  onSome: (secret) =>
    makeBotRpcServer(secret).pipe(
      HttpServer.withLogAddress,
      Layer.provide(NodeHttpServer.layer(createServer, { port: BOT_RPC_PORT })),
    ),
}).pipe(Layer.withSpan('BotRpc'));
