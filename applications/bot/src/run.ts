import { NodeHttpClient, NodeSocket } from '@effect/platform-node';
import { Runtime, Telemetry } from '@sideline/effect-lib';
import * as DiscordConfig from 'dfx/DiscordConfig';
import { Config, Effect, Layer } from 'effect';
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc';
import { env } from '~/env.js';
import { AppLive, Bot } from '~/index.js';

const RpcProtocol = RpcClient.layerProtocolHttp({
  url: env.SERVER_URL + env.RPC_PREFIX,
}).pipe(Layer.provide(NodeHttpClient.layerUndici), Layer.provide(RpcSerialization.layerNdjson));

const MainLive = AppLive.pipe(
  Layer.provide(RpcProtocol),
  /**
   * `layerFetch` for Discord, NOT `layerUndici` — because file uploads are
   * multipart, and `layerUndici` does not send a multipart body at all.
   *
   * `NodeHttpClient` maps a `FormData` body straight onto undici's low-level
   * `request()`, which — unlike `fetch` — does not accept `FormData`. The body
   * is silently never written: the peer waits for bytes that never arrive and
   * eventually gives up. Against a local server that surfaces as a 408; against
   * Discord it is `SocketError: other side closed`, which reads like a network
   * blip and is completely deterministic.
   *
   * Measured against a throwaway server in this image, 200 KB multipart:
   *
   *   layerUndici     FormData → 408, server received NOTHING
   *   layerNodeHttp   FormData → delivered, but chunked with no Content-Length
   *   layerFetch      FormData → delivered, Content-Length: 200302
   *
   * Only `layerFetch` sends it the way Discord expects. Plain JSON calls
   * (`Uint8Array` bodies) work on all three, which is why every other Discord
   * call the bot makes has always been fine and only the quiz attachment broke.
   *
   * The RPC protocol above deliberately stays on undici: it streams NDJSON from
   * the server and is unaffected by any of this.
   */
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(
    DiscordConfig.layerConfig({
      token: Config.succeed(env.DISCORD_BOT_TOKEN),
      gateway: Config.succeed({ intents: env.DISCORD_GATEWAY_INTENTS }),
    }),
  ),
);

Effect.provide(Bot.program, MainLive).pipe(
  Runtime.runMain(
    env.NODE_ENV,
    env.LOG_LEVEL,
    Telemetry.makeTelemetryLayer({
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
      environment: env.APP_ENV,
      origin: env.APP_ORIGIN,
    }),
  ),
);
