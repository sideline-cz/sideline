// Spec for `chatWithTools` — plan `.work-plans/ai-app-interaction.md` §6 / §13.1.
//
// These tests are written against the injected-client design the plan mandates: `makeReal`
// receives its `HttpClient` from the outer layer graph (matching the existing `summarizeChannel`
// pattern), so real-provider tests build the layer directly from the exported
// `makeReal` with a mock `HttpClient.HttpClient` layer — see `applications/server/AGENTS.md`
// → "Config-Gated External Service Provider" rule 4.

import { afterEach, describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option, Redacted } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { vi } from 'vitest';
import {
  type ChatWithToolsInput,
  type ChatWithToolsResult,
  type LlmChatMessage,
  LlmClient,
  type LlmError,
  type LlmToolCall,
  type LlmToolDefinition,
  makeReal,
} from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// Mock a bare `LLM env` module so `LlmClient.Default` can be exercised with a
// non-empty LLM_API_URL / LLM_API_KEY (case 10) without touching the shared
// process env used by every other test file (vitest.config.ts sets both to
// `''`, which is what keeps case 9's "no HttpClient" assertion meaningful).
// The `effect` import is done dynamically inside the factory so this mock has
// no dependency on the file's own top-level import ordering.
// ---------------------------------------------------------------------------

vi.mock('~/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/env.js')>();
  const { Option: EffectOption, Redacted: EffectRedacted } = await import('effect');
  return {
    ...actual,
    env: {
      ...actual.env,
      LLM_API_URL: 'https://api.test.mocked/v1',
      LLM_API_KEY: EffectOption.some(EffectRedacted.make('mocked-test-key')),
      LLM_MODEL: 'gpt-4o-mini-mocked',
    },
  };
});

// ---------------------------------------------------------------------------
// Request-body capture + mock HttpClient layer factory
// (same shape as the established pattern in `src/services/LlmClient.test.ts`)
// ---------------------------------------------------------------------------

let capturedRequests: Array<{ url: string; body: unknown }> = [];

const resetCapturedRequests = () => {
  capturedRequests = [];
};

afterEach(() => {
  resetCapturedRequests();
});

const readRequestBody = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
): unknown => {
  const body = request.body as { readonly _tag: string; readonly body?: Uint8Array };
  if (body._tag === 'Uint8Array' && body.body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** Build a `Layer<HttpClient.HttpClient>` returning a fixed status/body and capturing every request. */
const makeMockHttpClientLayer = (
  responseBody: unknown,
  status = 200,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = readRequestBody(request);
      capturedRequests.push({ url: String(request.url), body });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
            { status, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
    }),
  );

/** Build an `LlmClient` layer backed by the real provider with an injected mock HttpClient. */
const makeLlmClientRealWithHttp = (httpLayer: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.effect(
    LlmClient,
    HttpClient.HttpClient.asEffect().pipe(
      Effect.map((client) =>
        makeReal('https://api.test/v1', Redacted.make('test-key'), 'gpt-4o-mini', client),
      ),
    ),
  ).pipe(Layer.provide(httpLayer));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const twoTools: ReadonlyArray<LlmToolDefinition> = [
  {
    name: 'list_events',
    description: 'List events visible to the caller.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'list_members',
    description: 'List members visible to the caller.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

const userMessage = (content: string): LlmChatMessage => ({ role: 'user', content });

const baseInput = (overrides: Partial<ChatWithToolsInput> = {}): ChatWithToolsInput => ({
  messages: [userMessage('What events are coming up?')],
  tools: twoTools,
  maxTokens: 500,
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. Request shape
// ---------------------------------------------------------------------------

describe('LlmClient.chatWithTools — request shape', () => {
  it.effect(
    'sends tools as {type:function, function:{name,description,parameters}}, tool_choice:auto, and no response_format',
    () => {
      resetCapturedRequests();
      const llmLayer = makeLlmClientRealWithHttp(
        makeMockHttpClientLayer({ choices: [{ message: { content: 'hi' } }] }),
      );

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) => llm.chatWithTools(baseInput())),
        Effect.provide(llmLayer),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(capturedRequests).toHaveLength(1);
            const body = capturedRequests[0]?.body as {
              tools?: Array<{
                type: string;
                function: { name: string; description: string; parameters: unknown };
              }>;
              tool_choice?: string;
              response_format?: unknown;
            };
            expect(body.tools).toHaveLength(2);
            for (const tool of body.tools ?? []) {
              expect(tool.type).toBe('function');
              expect(typeof tool.function.name).toBe('string');
              expect(typeof tool.function.description).toBe('string');
              expect(typeof tool.function.parameters).toBe('object');
            }
            expect(body.tool_choice).toBe('auto');
            expect(Object.keys(body)).not.toContain('response_format');
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 2-4. Response decoding
// ---------------------------------------------------------------------------

describe('LlmClient.chatWithTools — response decoding', () => {
  it.effect('text answer with tool_calls key entirely absent decodes to toolCalls: []', () => {
    const llmLayer = makeLlmClientRealWithHttp(
      makeMockHttpClientLayer({ choices: [{ message: { content: 'hi' } }] }),
    );

    return LlmClient.asEffect().pipe(
      Effect.flatMap((llm) => llm.chatWithTools(baseInput())),
      Effect.provide(llmLayer),
      Effect.tap((result: ChatWithToolsResult) =>
        Effect.sync(() => {
          expect(Option.isSome(result.content)).toBe(true);
          expect(Option.getOrThrow(result.content)).toBe('hi');
          expect(result.toolCalls).toEqual([]);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect(
    'tool-call answer with content key entirely absent decodes content:None and one tool call',
    () => {
      const llmLayer = makeLlmClientRealWithHttp(
        makeMockHttpClientLayer({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'list_events', arguments: '{"limit":5}' },
                  },
                ],
              },
            },
          ],
        }),
      );

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) => llm.chatWithTools(baseInput())),
        Effect.provide(llmLayer),
        Effect.tap((result: ChatWithToolsResult) =>
          Effect.sync(() => {
            expect(Option.isNone(result.content)).toBe(true);
            expect(result.toolCalls).toHaveLength(1);
            const call: LlmToolCall | undefined = result.toolCalls[0];
            expect(call?.id).toBe('c1');
            expect(call?.name).toBe('list_events');
            expect(call?.argumentsJson).toBe('{"limit":5}');
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect('mixed answer: content AND tool_calls both present are both returned', () => {
    const llmLayer = makeLlmClientRealWithHttp(
      makeMockHttpClientLayer({
        choices: [
          {
            message: {
              content: 'Let me check that for you.',
              tool_calls: [
                {
                  id: 'c2',
                  type: 'function',
                  function: { name: 'list_members', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    );

    return LlmClient.asEffect().pipe(
      Effect.flatMap((llm) => llm.chatWithTools(baseInput())),
      Effect.provide(llmLayer),
      Effect.tap((result: ChatWithToolsResult) =>
        Effect.sync(() => {
          expect(Option.getOrThrow(result.content)).toBe('Let me check that for you.');
          expect(result.toolCalls).toHaveLength(1);
          expect(result.toolCalls[0]?.name).toBe('list_members');
        }),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// 5-7. Transport failures
// ---------------------------------------------------------------------------

describe('LlmClient.chatWithTools — transport failures surface as LlmError', () => {
  it.effect('no choices → LlmError', () => {
    const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer({ choices: [] }));

    return LlmClient.asEffect().pipe(
      Effect.flatMap((llm) => llm.chatWithTools(baseInput())),
      Effect.provide(llmLayer),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect((result.failure as LlmError)._tag).toBe('LlmError');
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('malformed JSON body → LlmError whose message mentions parse', () => {
    const llmLayer = makeLlmClientRealWithHttp(
      makeMockHttpClientLayer('this is not { valid json at all', 200),
    );

    return LlmClient.asEffect().pipe(
      Effect.flatMap((llm) => llm.chatWithTools(baseInput())),
      Effect.provide(llmLayer),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as LlmError;
            expect(err._tag).toBe('LlmError');
            expect(err.message.toLowerCase()).toContain('parse');
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('HTTP 500 → LlmError', () => {
    const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer({ error: 'boom' }, 500));

    return LlmClient.asEffect().pipe(
      Effect.flatMap((llm) => llm.chatWithTools(baseInput())),
      Effect.provide(llmLayer),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect((result.failure as LlmError)._tag).toBe('LlmError');
          }
        }),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Assistant + tool history re-encoding
// ---------------------------------------------------------------------------

describe('LlmClient.chatWithTools — history re-encoding', () => {
  it.effect(
    'assistant message with tool calls + a tool-role result are re-encoded on the request body',
    () => {
      resetCapturedRequests();
      const llmLayer = makeLlmClientRealWithHttp(
        makeMockHttpClientLayer({ choices: [{ message: { content: 'done' } }] }),
      );

      const history: ReadonlyArray<LlmChatMessage> = [
        userMessage('What events are coming up?'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'list_events', argumentsJson: '{"limit":5}' }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: '{"events":[]}',
        },
      ];

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) => llm.chatWithTools(baseInput({ messages: history }))),
        Effect.provide(llmLayer),
        Effect.tap(() =>
          Effect.sync(() => {
            const body = capturedRequests[0]?.body as {
              messages: ReadonlyArray<{
                role: string;
                content?: unknown;
                tool_calls?: Array<{
                  id: string;
                  type: string;
                  function: { name: string; arguments: string };
                }>;
                tool_call_id?: string;
              }>;
            };
            const assistantEntry = body.messages.find((m) => m.role === 'assistant');
            expect(assistantEntry).toBeDefined();
            expect(assistantEntry?.tool_calls).toHaveLength(1);
            expect(assistantEntry?.tool_calls?.[0]?.id).toBe('call-1');
            expect(assistantEntry?.tool_calls?.[0]?.function.name).toBe('list_events');
            expect(assistantEntry?.tool_calls?.[0]?.function.arguments).toBe('{"limit":5}');

            const toolEntry = body.messages.find((m) => m.role === 'tool');
            expect(toolEntry).toBeDefined();
            expect(toolEntry?.tool_call_id).toBe('call-1');
            expect(toolEntry?.content).toBe('{"events":[]}');
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 9. Stub path
// ---------------------------------------------------------------------------

describe('LlmClient.chatWithTools — stub path (no HttpClient in the layer)', () => {
  it.effect('configured is false and chatWithTools returns toolCalls: [] deterministically', () =>
    Effect.Do.pipe(
      Effect.bind('llm', () => LlmClient.asEffect()),
      Effect.bind('r1', ({ llm }) => llm.chatWithTools(baseInput())),
      Effect.bind('r2', ({ llm }) => llm.chatWithTools(baseInput())),
      Effect.tap(({ llm, r1, r2 }) =>
        Effect.sync(() => {
          expect(llm.configured).toBe(false);
          expect(r1.toolCalls).toEqual([]);
          expect(r2.toolCalls).toEqual([]);
          expect(r1.content).toEqual(r2.content);
          expect(r1.finishReason).toEqual(r2.finishReason);
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );
});

// ---------------------------------------------------------------------------
// 10. `configured` flag with a mock HttpClient and LLM env set
// ---------------------------------------------------------------------------

describe('LlmClient.chatWithTools — configured flag', () => {
  it.effect('configured is true when both a HttpClient and LLM env are present', () => {
    const httpLayer = makeMockHttpClientLayer({ choices: [{ message: { content: 'hi' } }] });

    return LlmClient.asEffect().pipe(
      Effect.tap((llm) =>
        Effect.sync(() => {
          expect(llm.configured).toBe(true);
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
      Effect.provide(httpLayer),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Existing `OpenAiResponseSchema` regression — no `content` key at all
// ---------------------------------------------------------------------------

describe('LlmClient.summarizeEmail — regression: message has no content key', () => {
  it.effect('decodes successfully instead of failing to parse (finding #4)', () => {
    const llmLayer = makeLlmClientRealWithHttp(
      makeMockHttpClientLayer({ choices: [{ message: {} }] }),
    );

    return LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeEmail({
          subject: 'No content key',
          from: 'sender@example.com',
          body: 'Body text.',
        }),
      ),
      Effect.provide(llmLayer),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          // The provider fails with LlmError("LLM returned null content") — a real
          // failure, not a schema *decode* failure. Before the fix, the missing
          // `content` key made `OptionFromNullOr` reject the whole response with
          // a ParseError wrapped as "LLM response parse failed", indistinguishable
          // from a genuinely malformed payload. After the fix, decoding succeeds
          // and the (still legitimate) empty-content failure is a plain LlmError
          // whose message does NOT mention "parse failed".
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as LlmError;
            expect(err._tag).toBe('LlmError');
            expect(err.message).not.toContain('parse failed');
          }
        }),
      ),
      Effect.asVoid,
    );
  });
});
