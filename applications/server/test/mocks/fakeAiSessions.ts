import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeHttpClient } from '@effect/platform-node';
import { Effect, Layer, Redacted } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { LlmClient, makeReal } from '~/services/LlmClient.js';

/**
 * A fake ai-sessions server: a real HTTP listener that answers from a script, so tests exercise
 * the same node:http transport, status handling and retries as production.
 */

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: {
    readonly model?: string;
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    readonly [key: string]: unknown;
  };
}

export interface ScriptedResponse {
  readonly status: number;
  readonly body: unknown;
}

export const completion = (content: string, finishReason = 'stop'): ScriptedResponse => ({
  status: 200,
  body: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'claude',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
  },
});

export const jsonCompletion = (value: unknown, finishReason = 'stop') =>
  completion(JSON.stringify(value), finishReason);

export const apiError = (status: number, message: string): ScriptedResponse => ({
  status,
  body: { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error' } },
});

export const TEST_TOKEN = 'test-ai-sessions-token';

export interface FakeAiSessions {
  readonly url: string;
  readonly requests: Array<CapturedRequest>;
  /** Queue responses; each request takes the next one (500 when the script runs out). */
  readonly script: (...responses: ReadonlyArray<ScriptedResponse>) => void;
  readonly reset: () => void;
  readonly close: () => Promise<void>;
  /** `LlmClient` backed by `makeReal` against this server over node:http. */
  readonly layer: Layer.Layer<LlmClient>;
}

export const startFakeAiSessions = async (): Promise<FakeAiSessions> => {
  const requests: Array<CapturedRequest> = [];
  let queue: Array<ScriptedResponse> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw === '' ? { messages: [] } : (JSON.parse(raw) as CapturedRequest['body']),
      });
      const next = queue.shift() ?? apiError(500, 'fake ai-sessions: script exhausted');
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    requests,
    script: (...responses) => {
      queue = [...queue, ...responses];
    },
    reset: () => {
      queue = [];
      requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    layer: Layer.effect(
      LlmClient,
      HttpClient.HttpClient.asEffect().pipe(
        Effect.map((client) => makeReal(url, Redacted.make(TEST_TOKEN), client)),
      ),
    ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
  };
};
