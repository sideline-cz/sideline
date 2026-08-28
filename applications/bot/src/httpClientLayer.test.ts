// Pins the HTTP client layer Discord traffic goes through.
//
// `layerUndici` does not send a multipart body AT ALL. `NodeHttpClient` maps a
// `FormData` body onto undici's low-level `request()`, which — unlike `fetch`
// — does not accept `FormData`, so the bytes are never written. The peer waits
// for a body that never arrives: a local server answers 408, Discord closes
// the connection and the bot sees `SocketError: other side closed`.
//
// That reads exactly like a transient network fault and is entirely
// deterministic, which is why it survived four retries and cost an evening.
//
// Measured in the production image against a throwaway server, 200 KB
// multipart:
//
//   layerUndici     FormData → 408, server received NOTHING
//   layerNodeHttp   FormData → delivered, chunked, no Content-Length
//   layerFetch      FormData → delivered, Content-Length: 200302
//
// Plain JSON (`Uint8Array`) bodies work on all three, which is why every other
// Discord call the bot makes was always fine and only the quiz attachment
// broke.
//
// A unit test cannot exercise the socket, so this asserts the decision itself:
// the Discord client must not be undici while it uploads files. Swapping it
// back would otherwise type-check, pass every other test, and silently stop
// every attachment the bot sends.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUN_TS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'run.ts'), 'utf8');

/** The `Layer.provide` that feeds `DiscordREST`, i.e. everything after the RPC
 * protocol is constructed. The RPC protocol above it legitimately uses undici
 * — it streams NDJSON and none of this applies to it. */
const discordLayerSection = RUN_TS.slice(RUN_TS.indexOf('const MainLive'));

describe('Discord HTTP client layer', () => {
  it('uploads multipart through a client that actually sends it', () => {
    expect(discordLayerSection).toContain('NodeHttpClient.layerFetch');
  });

  it('does not route Discord traffic through undici', () => {
    expect(discordLayerSection).not.toContain('NodeHttpClient.layerUndici');
  });

  it('leaves the NDJSON RPC protocol on undici', () => {
    const rpcSection = RUN_TS.slice(
      RUN_TS.indexOf('const RpcProtocol'),
      RUN_TS.indexOf('const MainLive'),
    );
    expect(rpcSection).toContain('NodeHttpClient.layerUndici');
  });
});
