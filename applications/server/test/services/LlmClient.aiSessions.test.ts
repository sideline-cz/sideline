// LlmClient against a fake ai-sessions server (never the real one): the OpenAI-compatible
// transport, retries, and tool calling emulated through json_schema.

import { NodeHttpClient } from '@effect/platform-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { vi } from 'vitest';
import {
  ASSISTANT_MODEL,
  type ChatWithToolsInput,
  FAST_MODEL,
  type LlmChatMessage,
  LlmClient,
  type LlmClientService,
  type LlmToolDefinition,
  NO_AGENT_TOOLS_INSTRUCTION,
  validateJsonSchema,
} from '~/services/LlmClient.js';
import {
  apiError,
  completion,
  type FakeAiSessions,
  jsonCompletion,
  startFakeAiSessions,
  TEST_TOKEN,
} from '../mocks/fakeAiSessions.js';

// `LlmClient.Default` reads these at construction; tests flip them to cover both selections.
const aiEnv = vi.hoisted(() => ({
  url: '',
  token: undefined as string | undefined,
}));

vi.mock('~/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/env.js')>();
  const { Option: O, Redacted: R } = await import('effect');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'AI_SESSIONS_URL'
          ? aiEnv.url
          : key === 'AI_SESSIONS_TOKEN'
            ? aiEnv.token === undefined
              ? O.none()
              : O.some(R.make(aiEnv.token))
            : Reflect.get(target, key),
    }),
  };
});

let fake: FakeAiSessions;

beforeAll(async () => {
  fake = await startFakeAiSessions();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.reset();
  aiEnv.url = '';
  aiEnv.token = undefined;
});

const LIST_EVENTS: LlmToolDefinition = {
  name: 'list_events',
  description: 'List upcoming events.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      eventType: { type: 'string', enum: ['training', 'match'] },
    },
    required: ['limit'],
    additionalProperties: false,
  },
};

const chatInput = (messages: ReadonlyArray<LlmChatMessage>): ChatWithToolsInput => ({
  messages,
  tools: [LIST_EVENTS],
  maxTokens: 450,
});

const question: ReadonlyArray<LlmChatMessage> = [
  { role: 'system', content: 'You are the team assistant.' },
  { role: 'user', content: 'What is next?' },
];

const withLlm = <A, E>(f: (llm: LlmClientService) => Effect.Effect<A, E>) =>
  LlmClient.asEffect().pipe(Effect.flatMap(f), Effect.provide(fake.layer));

const systemText = (i: number) =>
  (fake.requests[i]?.body.messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

describe('LlmClient → ai-sessions transport', () => {
  it.effect('normal completion: Haiku, bearer token, /v1/chat/completions, no sampling knobs', () =>
    Effect.gen(function* () {
      fake.script(completion('Steady climber, 12-3-1.'));
      const result = yield* withLlm((llm) =>
        llm.generateRatingInsight({
          rating: 1300,
          gamesPlayed: 16,
          wins: 12,
          losses: 3,
          draws: 1,
          isCalibrating: false,
          calibrationThreshold: 10,
          recentDeltas: [5, 8],
          locale: 'en',
        }),
      );
      expect(result).toEqual({ insight: 'Steady climber, 12-3-1.', generated: true });
      const req = fake.requests[0];
      expect(req?.method).toBe('POST');
      expect(req?.path).toBe('/v1/chat/completions');
      expect(req?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(req?.body.model).toBe(FAST_MODEL);
      expect(req?.body).not.toHaveProperty('temperature');
      expect(req?.body).not.toHaveProperty('tools');
    }),
  );

  it.effect('json_schema response: the summarizer asks for a schema and validates the result', () =>
    Effect.gen(function* () {
      fake.script(jsonCompletion({ short: '📅 Sat 10:00', detailed: 'Practice on Saturday.' }));
      const result = yield* withLlm((llm) =>
        llm.summarizeEmail({ subject: 'Practice', from: 'coach@example.com', body: 'Sat 10:00' }),
      );
      expect(result).toEqual({ short: '📅 Sat 10:00', detailed: 'Practice on Saturday.' });
      const body = fake.requests[0]?.body;
      expect(body?.model).toBe(FAST_MODEL);
      expect(body?.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { schema: { required: ['short', 'detailed'] } },
      });
    }),
  );

  it.effect('finish_reason "length": a cut-off summary falls back instead of failing', () =>
    Effect.gen(function* () {
      fake.script(completion('{"short":"📅 Sat","detailed":"Practice on Satur', 'length'));
      const result = yield* withLlm((llm) =>
        llm.summarizeEmail({ subject: 'Practice', from: 'coach@example.com', body: 'Sat' }),
      );
      expect(result.detailed).toBe('{"short":"📅 Sat","detailed":"Practice on Satur');
    }),
  );

  it.effect('finish_reason "length" on an assistant answer is passed through', () =>
    Effect.gen(function* () {
      fake.script(jsonCompletion({ type: 'answer', content: 'Training on Sat' }, 'length'));
      const result = yield* withLlm((llm) => llm.chatWithTools(chatInput(question)));
      expect(result.finishReason).toBe('length');
      expect(result.content).toEqual(Option.some('Training on Sat'));
    }),
  );

  it.live('a 502 is retried and the retry succeeds', () =>
    Effect.gen(function* () {
      fake.script(apiError(502, 'session failed'), completion('Recovered.'));
      const result = yield* withLlm((llm) =>
        llm.summarizeChannel({
          messages: [{ author: 'a', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }],
          channelName: 'general',
          locale: 'en',
        }),
      );
      expect(fake.requests).toHaveLength(2);
      // "Recovered." is not the JSON shape, so the deterministic fallback is used; the point is
      // that the second request was made and answered.
      expect(result.generated).toBe(false);
    }),
  );

  it.live('5xx is retried at most twice, then surfaces as LlmError', () =>
    Effect.gen(function* () {
      fake.script(apiError(503, 'a'), apiError(502, 'b'), apiError(502, 'c'));
      const error = yield* withLlm((llm) =>
        llm.summarizeEmail({ subject: 's', from: 'f', body: 'b' }),
      ).pipe(Effect.flip);
      expect(fake.requests).toHaveLength(3);
      expect(error.status).toBe(502);
    }),
  );

  it.effect('a 401 surfaces as LlmError at once, without a retry', () =>
    Effect.gen(function* () {
      fake.script(apiError(401, 'invalid token'));
      const error = yield* withLlm((llm) =>
        llm.summarizeEmail({ subject: 's', from: 'f', body: 'b' }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe('LlmError');
      expect(error.status).toBe(401);
      expect(error.message).toContain('invalid token');
      expect(fake.requests).toHaveLength(1);
    }),
  );

  it.effect('a 400 is not retried either', () =>
    Effect.gen(function* () {
      fake.script(apiError(400, 'tools are not supported'));
      const error = yield* withLlm((llm) => llm.chatWithTools(chatInput(question))).pipe(
        Effect.flip,
      );
      expect(error.status).toBe(400);
      expect(fake.requests).toHaveLength(1);
    }),
  );

  it.effect('every call tells Claude not to use its own tools', () =>
    Effect.gen(function* () {
      fake.script(
        jsonCompletion({ short: 's', detailed: 'd' }),
        jsonCompletion({ type: 'answer', content: 'ok' }),
      );
      yield* withLlm((llm) => llm.summarizeEmail({ subject: 's', from: 'f', body: 'b' }));
      yield* withLlm((llm) => llm.chatWithTools(chatInput(question)));
      for (const i of [0, 1]) {
        expect(systemText(i)).toContain(NO_AGENT_TOOLS_INSTRUCTION);
        expect(systemText(i)).toMatch(/no web search/);
      }
    }),
  );
});

describe('LlmClient.chatWithTools — tool calling emulated over json_schema', () => {
  it.effect('round trip: tool_calls, then results as a user message, then an answer', () =>
    Effect.gen(function* () {
      fake.script(
        jsonCompletion({
          type: 'tool_calls',
          calls: [{ name: 'list_events', arguments: { limit: 3, eventType: 'training' } }],
        }),
        jsonCompletion({ type: 'answer', content: 'Training on Saturday at 10:00.' }),
      );

      const first = yield* withLlm((llm) => llm.chatWithTools(chatInput(question)));
      expect(first.content).toEqual(Option.none());
      expect(first.toolCalls).toHaveLength(1);
      const call = first.toolCalls[0];
      expect(call?.name).toBe('list_events');
      expect(JSON.parse(call?.argumentsJson ?? '')).toEqual({ limit: 3, eventType: 'training' });

      const firstBody = fake.requests[0]?.body;
      expect(firstBody?.model).toBe(ASSISTANT_MODEL);
      expect(firstBody).not.toHaveProperty('tools');
      expect(firstBody).not.toHaveProperty('tool_choice');
      expect(firstBody?.response_format).toMatchObject({ type: 'json_schema' });
      // ai-sessions hands this schema to Claude as a tool input_schema, and the Anthropic API
      // rejects oneOf/allOf/anyOf at its top level (stable 502'd every assistant turn on it).
      const replySchema = (
        firstBody?.response_format as { json_schema?: { schema?: object } } | undefined
      )?.json_schema?.schema;
      expect(replySchema).toMatchObject({ type: 'object' });
      for (const key of ['oneOf', 'allOf', 'anyOf']) expect(replySchema).not.toHaveProperty(key);
      // The tool definitions travel in a system message.
      expect(systemText(0)).toContain('list_events: List upcoming events.');
      expect(systemText(0)).toContain(JSON.stringify(LIST_EVENTS.parameters));

      // What ChatAgent sends next: the assistant turn with the calls, then one tool message each.
      const second = yield* withLlm((llm) =>
        llm.chatWithTools(
          chatInput([
            ...question,
            { role: 'assistant', content: '', toolCalls: first.toolCalls },
            { role: 'tool', toolCallId: call?.id ?? '', content: '[{"title":"Training"}]' },
          ]),
        ),
      );
      expect(second.content).toEqual(Option.some('Training on Saturday at 10:00.'));
      expect(second.toolCalls).toEqual([]);

      const wire = fake.requests[1]?.body.messages ?? [];
      expect(wire.map((m) => m.role)).not.toContain('tool');
      expect(wire.at(-1)?.role).toBe('user');
      expect(wire.at(-1)?.content).toContain('list_events');
      expect(wire.at(-1)?.content).toContain('[{"title":"Training"}]');
      expect(JSON.parse(wire.at(-2)?.content ?? '')).toEqual({
        type: 'tool_calls',
        calls: [{ name: 'list_events', arguments: { limit: 3, eventType: 'training' } }],
      });
    }),
  );

  it.effect('a malformed tool call gets one retry carrying the validation error', () =>
    Effect.gen(function* () {
      fake.script(
        jsonCompletion({ type: 'tool_calls', calls: [{ name: 'drop_database', arguments: {} }] }),
        jsonCompletion({
          type: 'tool_calls',
          calls: [{ name: 'list_events', arguments: { limit: 5 } }],
        }),
      );
      const result = yield* withLlm((llm) => llm.chatWithTools(chatInput(question)));
      expect(result.toolCalls.map((c) => c.name)).toEqual(['list_events']);
      expect(fake.requests).toHaveLength(2);
      const retry = fake.requests[1]?.body.messages ?? [];
      expect(retry.at(-2)?.role).toBe('assistant');
      expect(retry.at(-1)?.role).toBe('user');
      expect(retry.at(-1)?.content).toContain('unknown tool "drop_database"');
    }),
  );

  it.effect(
    'arguments failing the tool schema count as malformed; a second failure fails the turn',
    () =>
      Effect.gen(function* () {
        fake.script(
          jsonCompletion({
            type: 'tool_calls',
            calls: [{ name: 'list_events', arguments: { limit: 500 } }],
          }),
          completion('Sure! Here are your events.'),
        );
        const error = yield* withLlm((llm) => llm.chatWithTools(chatInput(question))).pipe(
          Effect.flip,
        );
        expect(error._tag).toBe('LlmError');
        expect(error.message).toContain('malformed');
        expect(fake.requests).toHaveLength(2);
        expect(fake.requests[1]?.body.messages.at(-1)?.content).toContain(
          'arguments.limit must be <= 50',
        );
      }),
  );
});

describe('validateJsonSchema', () => {
  const schema = LIST_EVENTS.parameters;
  it('accepts matching arguments', () => {
    expect(validateJsonSchema(schema, { limit: 2, eventType: 'match' })).toBeUndefined();
  });
  it.each([
    [{}, 'arguments.limit is required'],
    [{ limit: 1.5 }, 'arguments.limit must be of type integer'],
    [{ limit: 2, eventType: 'party' }, 'arguments.eventType must be one of'],
    [{ limit: 2, extra: true }, 'arguments.extra is not allowed'],
    [[], 'arguments must be of type object'],
  ])('rejects %j', (value, message) => {
    expect(validateJsonSchema(schema, value)).toContain(message);
  });
  it('checks strings, patterns and arrays', () => {
    const s = {
      type: 'object',
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        title: { type: 'string', minLength: 1, maxLength: 3 },
        ids: { type: 'array', maxItems: 1, items: { type: 'string' } },
      },
    };
    expect(validateJsonSchema(s, { date: '2026-01-01', title: 'a', ids: ['x'] })).toBeUndefined();
    expect(validateJsonSchema(s, { date: 'tomorrow' })).toContain('must match');
    expect(validateJsonSchema(s, { title: '' })).toContain('at least 1');
    expect(validateJsonSchema(s, { title: 'abcd' })).toContain('at most 3');
    expect(validateJsonSchema(s, { ids: ['x', 'y'] })).toContain('at most 1 items');
    expect(validateJsonSchema(s, { ids: [1] })).toContain('arguments.ids[0]');
  });
});

describe('LlmClient.Default provider selection', () => {
  it.effect('no AI_SESSIONS_URL / token → stub, even with an HttpClient', () =>
    LlmClient.asEffect().pipe(
      Effect.tap((llm) => Effect.sync(() => expect(llm.configured).toBe(false))),
      Effect.provide(LlmClient.Default),
      Effect.provide(NodeHttpClient.layerNodeHttp),
    ),
  );

  it.effect('AI_SESSIONS_URL + token (env fallback) → real provider calling <url>/v1', () =>
    Effect.gen(function* () {
      aiEnv.url = `${fake.url}/`;
      aiEnv.token = 'env-token';
      fake.script(completion('Insight.'));
      const llm = yield* LlmClient.asEffect().pipe(Effect.provide(LlmClient.Live));
      expect(llm.configured).toBe(true);
      yield* llm.generateRatingInsight({
        rating: 1200,
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        draws: 0,
        isCalibrating: true,
        calibrationThreshold: 10,
        recentDeltas: [],
        locale: 'cs',
      });
      expect(fake.requests[0]?.path).toBe('/v1/chat/completions');
      expect(fake.requests[0]?.headers.authorization).toBe('Bearer env-token');
    }),
  );
});
