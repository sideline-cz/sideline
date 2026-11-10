import { NodeHttpClient } from '@effect/platform-node';
import { BotRpcs } from '@sideline/domain';
import { Data, type Duration, Effect, Layer, Option, type Redacted, ServiceMap } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc';
import { env } from '~/env.js';

// Server -> bot RPC client. The bot serves `BotRpcs` on its own port behind a Bearer secret.
export class BotRpcUnavailable extends Data.TaggedError('BotRpcUnavailable')<{
  readonly reason: 'not_configured' | 'timeout' | 'transport';
  readonly cause?: unknown;
}> {}

export interface BotRpcShape {
  readonly ping: Effect.Effect<BotRpcs.PingResult, BotRpcUnavailable>;
}

const transport = (cause: unknown) =>
  Effect.fail(new BotRpcUnavailable({ reason: 'transport', cause }));

// A protocol without `layerProtocolHttp`: its `transformClient` type rejects `filterStatusOk`.
// `filterStatusOk` matters: with NDJSON an empty 401 body gives zero frames, and the call waits forever.
const protocol = (url: string, secret: Redacted.Redacted<string>) =>
  Layer.effect(
    RpcClient.Protocol,
    HttpClient.HttpClient.asEffect().pipe(
      Effect.flatMap((client) =>
        RpcClient.makeProtocolHttp(
          client.pipe(
            HttpClient.mapRequest(HttpClientRequest.prependUrl(url)),
            HttpClient.mapRequest(HttpClientRequest.bearerToken(secret)),
            HttpClient.filterStatusOk,
          ),
        ),
      ),
    ),
  ).pipe(Layer.provide([NodeHttpClient.layerUndici, RpcSerialization.layerNdjson]));

export class BotRpc extends ServiceMap.Service<BotRpc, BotRpcShape>()('api/BotRpc') {
  static readonly layer = (options: {
    readonly url: Option.Option<string>;
    readonly secret: Option.Option<Redacted.Redacted<string>>;
    readonly timeout?: Duration.Input;
  }): Layer.Layer<BotRpc> => {
    if (Option.isNone(options.url) || Option.isNone(options.secret)) {
      return Layer.succeed(BotRpc, {
        ping: Effect.fail(new BotRpcUnavailable({ reason: 'not_configured' })),
      });
    }
    const timeout = options.timeout ?? '5 seconds';
    return Layer.effect(
      BotRpc,
      RpcClient.make(BotRpcs.BotRpcs).pipe(
        Effect.map((client) => ({
          ping: client['Bot/Ping']().pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new BotRpcUnavailable({ reason: 'timeout' })),
            }),
            Effect.catchTag('RpcClientError', transport),
            Effect.catchDefect(transport),
          ),
        })),
      ),
    ).pipe(Layer.provide(protocol(options.url.value, options.secret.value)));
  };

  static readonly Default = BotRpc.layer({ url: env.BOT_RPC_URL, secret: env.BOT_RPC_SECRET });
}
