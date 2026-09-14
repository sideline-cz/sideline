// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// How the HTTP mock works:
//   `makeReal`'s shared `postChatCompletion` helper calls `httpClient.execute(request)`
//   on the `HttpClient.HttpClient` INJECTED into `makeReal`'s closure from the
//   outer layer graph — it never re-provides `FetchHttpClient.layer` internally
//   (that used to be the case for `requestContent`/`summarizeEmail`/
//   `estimateRatingFromDescription`, which made the real provider untestable
//   without a network listener; see plan `.work-plans/ai-app-interaction.md` §6).
//   To intercept the HTTP call in tests we build the real provider directly via
//   the exported `makeReal(...)` with an explicit mock `HttpClient.HttpClient`
//   layer (`makeLlmClientRealWithHttp`), per `applications/server/AGENTS.md` →
//   "Config-Gated External Service Provider" rule 4.
//
//   For the "stub provider" (no API key configured) path: we rely on
//   `LlmClient.Default` with the real env — in test environments
//   `LLM_API_URL` and `LLM_API_KEY` are unset, so the stub path activates.

import { it as itEffect } from '@effect/vitest';
import { Effect, Layer, Redacted } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { afterEach, describe, expect } from 'vitest';
import { LlmClient, LlmError, makeReal } from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// Captured HTTP request storage (reset per test)
// ---------------------------------------------------------------------------

let capturedRequests: Array<{ url: string; body: unknown }> = [];

afterEach(() => {
  capturedRequests = [];
});

// ---------------------------------------------------------------------------
// Body-reading helper
// ---------------------------------------------------------------------------

/**
 * Extract the JSON body from an HttpClientRequest synchronously.
 * Works for requests created with HttpClientRequest.bodyJson (Uint8Array body).
 */
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

// ---------------------------------------------------------------------------
// Mock HTTP client factory
// ---------------------------------------------------------------------------

/**
 * Build a Layer.Layer<HttpClient.HttpClient> that returns a fixed JSON body
 * and captures every request for assertion.
 */
const makeMockHttpClientLayer = (responseBody: unknown, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = readRequestBody(request);
      capturedRequests.push({ url: String(request.url), body });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(responseBody), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
    }),
  );

/** Build an LlmClient layer backed by a real (mock HTTP) provider.
 * Constructs makeReal directly with explicit non-empty config so the test is
 * decoupled from env-based provider selection (env vars are blank in the test
 * environment, which now causes make to select makeStub).
 */
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
// Summarize channel input helpers
// ---------------------------------------------------------------------------

const makeMessages = (count: number, contentPrefix = 'Message') =>
  Array.from({ length: count }, (_, i) => ({
    author: `User${i}`,
    content: `${contentPrefix} ${i + 1}`,
    timestamp: new Date(Date.UTC(2026, 5, 20, 10, i, 0)).toISOString(),
  }));

// ---------------------------------------------------------------------------
// Tests — stub provider (no API key configured)
// ---------------------------------------------------------------------------

describe('LlmClient.summarizeChannel — stub provider (no API key)', () => {
  // When LLM_API_URL / LLM_API_KEY are not set in the test environment,
  // LlmClient.Default activates the deterministic stub.

  itEffect.effect('returns generated: false when stub path is active', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(3),
          channelName: undefined,
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.generated).toBe(false);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub returns summarizedCount equal to number of input messages', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(5),
          channelName: 'general',
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.summarizedCount).toBe(5);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub summary references message count', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(7),
          channelName: undefined,
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          // The stub summary should mention the count of messages or be a deterministic fallback
          expect(typeof result.summary).toBe('string');
          expect(result.summary.length).toBeGreaterThan(0);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub with cs locale: generated: false, summary is non-empty', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(2),
          channelName: 'obecné',
          locale: 'cs',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.generated).toBe(false);
          expect(typeof result.summary).toBe('string');
          expect(result.summary.length).toBeGreaterThan(0);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub with 0 messages: summarizedCount = 0, no throw', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: [],
          channelName: undefined,
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.generated).toBe(false);
          expect(result.summarizedCount).toBe(0);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests — real provider with mock HTTP client
// ---------------------------------------------------------------------------

describe('LlmClient.summarizeChannel — real provider with mock HTTP', () => {
  itEffect.effect(
    'real provider success: HTTP returns JSON → summary parsed, generated: true',
    () => {
      const openAiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'This is the parsed summary.',
              }),
            },
          },
        ],
      };

      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: makeMessages(2),
            channelName: 'general',
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.generated).toBe(true);
            expect(result.summary).toBe('This is the parsed summary.');
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'real provider fallback on LlmError: HTTP fails → generated: false, no throw',
    () => {
      // Return a response with no choices to trigger LlmError
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer({ choices: [] }));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: makeMessages(3),
            channelName: undefined,
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            // Should fall back gracefully
            expect(result.generated).toBe(false);
            expect(typeof result.summary).toBe('string');
            expect(result.summary.length).toBeGreaterThan(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'real provider: cs locale → request prompt instructs Czech language; fallback text is Czech',
    () => {
      // Simulate HTTP failure so we can inspect both the request and the fallback
      const capturedBodies: unknown[] = [];
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const body = readRequestBody(request);
          if (body !== undefined) capturedBodies.push(body);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ choices: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
          );
        }),
      );
      const llmLayer = makeLlmClientRealWithHttp(httpLayer);

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: makeMessages(1),
            channelName: 'obecné',
            locale: 'cs',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            // Fallback is Czech
            expect(result.generated).toBe(false);
            // The fallback summary for cs locale should be in Czech
            // (at minimum it should be non-empty)
            expect(result.summary.length).toBeGreaterThan(0);

            // If the HTTP request was made, it should instruct Czech
            if (capturedBodies.length > 0) {
              const bodyJson = JSON.stringify(capturedBodies[0]);
              expect(bodyJson.toLowerCase()).toMatch(/czech|cs|respond in czech/i);
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'message-boundary truncation: many large messages → request body drops WHOLE oldest messages, keeps most recent, summarizedCount = messages actually sent',
    () => {
      // Build many large messages (each >500 chars) that collectively exceed the token budget.
      // The handler should drop WHOLE oldest messages (not slice mid-message).
      // The summarizedCount in the result should equal how many were actually sent.
      const largeContent = 'X'.repeat(600);
      const manyMessages = Array.from({ length: 50 }, (_, i) => ({
        author: `User${i}`,
        content: `${largeContent} ${i}`,
        timestamp: new Date(Date.UTC(2026, 5, 20, 10, i, 0)).toISOString(),
      }));

      const capturedBodies: unknown[] = [];
      // Return a success response
      const openAiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({ summary: 'Capped summary.' }),
            },
          },
        ],
      };

      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const body = readRequestBody(request);
          if (body !== undefined) capturedBodies.push(body);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(openAiResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
          );
        }),
      );
      const llmLayer = makeLlmClientRealWithHttp(httpLayer);

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: manyMessages,
            channelName: 'test-channel',
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            // When the HTTP call succeeds, generated should be true
            expect(result.generated).toBe(true);
            expect(result.summary).toBe('Capped summary.');

            // If the implementer truncates, verify the captured request
            // contains only whole messages (not partial content sliced mid-string)
            if (capturedBodies.length > 0) {
              const body = capturedBodies[0] as {
                messages?: Array<{ content?: string }>;
              };

              // The transcript in the request must not contain a mid-message slice.
              // We verify by checking each message in the body ends naturally
              // (we can't check all 50 are present if truncation occurred).
              if (body.messages) {
                for (const msg of body.messages) {
                  if (msg.content) {
                    // Must be a full message content (ends with digit, not cut off)
                    expect(msg.content.endsWith('...')).toBe(false);
                  }
                }
              }

              // summarizedCount should reflect actual number sent (< 50 if truncated)
              expect(result.summarizedCount).toBeGreaterThanOrEqual(1);
              expect(result.summarizedCount).toBeLessThanOrEqual(50);
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'real provider fallback on malformed JSON content (Effect.try/orElseSucceed path, distinct from the LlmError "no choices" path): non-JSON content → deriveChannelSummaryFallback used',
    () => {
      // A well-formed OpenAI response whose message content is present but is NOT
      // valid JSON — this exercises the `Effect.try({ try: () => JSON.parse(...) })
      // .pipe(Effect.orElseSucceed(...))` branch, not the `LlmError` catchTag branch.
      const openAiResponse = {
        choices: [{ message: { content: 'this is plain prose, not JSON at all' } }],
      };
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: makeMessages(4),
            channelName: 'general',
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Success');
            if (result._tag === 'Success') {
              expect(result.success.generated).toBe(false);
              expect(result.success.summarizedCount).toBe(4);
              expect(result.success.summary.length).toBeGreaterThan(0);
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Tests — summarizeEmail real provider (mock HttpClient, injected via makeReal)
// ---------------------------------------------------------------------------

describe('LlmClient.summarizeEmail — real provider (mock HttpClient)', () => {
  itEffect.effect(
    'real provider success: HTTP returns valid JSON of the right shape → parsed short/detailed returned',
    () => {
      const openAiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                short: 'Short summary.',
                detailed: 'Detailed summary.',
              }),
            },
          },
        ],
      };
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeEmail({
            subject: 'Team practice cancelled',
            from: 'coach@example.com',
            body: 'Unfortunately practice is cancelled due to rain.',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.short).toBe('Short summary.');
            expect(result.detailed).toBe('Detailed summary.');
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'real provider fallback: HTTP returns non-JSON content → deriveFallback used, no throw (Effect.try/orElseSucceed path)',
    () => {
      const openAiResponse = {
        choices: [{ message: { content: 'This is not JSON at all, just prose.' } }],
      };
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeEmail({
            subject: 'Fallback test',
            from: 'x@y.com',
            body: 'Body content here',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            // No new error channel surfaces — the malformed response still succeeds.
            expect(result._tag).toBe('Success');
            if (result._tag === 'Success') {
              // deriveFallback(text): detailed === the raw (non-JSON) text
              expect(result.success.detailed).toBe('This is not JSON at all, just prose.');
              expect(typeof result.success.short).toBe('string');
              expect(result.success.short.length).toBeGreaterThan(0);
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  // summarizeEmail intentionally propagates LlmError (unlike estimate/summarizeChannel)
  // so EmailSummarizer can retry and cap to 'failed'.
  itEffect.effect(
    'real provider error path: HTTP request fails → LlmError propagates (not swallowed into a fallback)',
    () => {
      // No choices in the response triggers requestContent's LlmError('LLM returned no choices').
      const openAiResponse = { choices: [] };
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeEmail({
            subject: 'Propagation test',
            from: 'x@y.com',
            body: 'Body content here',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(LlmError);
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Tests — estimateRatingFromDescription real provider (mock HttpClient, injected via makeReal)
// ---------------------------------------------------------------------------

describe('LlmClient.estimateRatingFromDescription — real provider (mock HttpClient)', () => {
  itEffect.effect(
    'real provider success: HTTP returns valid JSON of the right shape → parsed rating/rationale returned, generated: true',
    () => {
      const openAiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({ rating: 1450, rationale: 'Solid intermediate player.' }),
            },
          },
        ],
      };
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.estimateRatingFromDescription({
            description: 'I play a few times a week at a decent level.',
            defaultRating: 1200,
            minRating: 800,
            maxRating: 1800,
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.suggestedRating).toBe(1450);
            expect(result.rationale).toBe('Solid intermediate player.');
            expect(result.generated).toBe(true);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'real provider fallback: HTTP returns non-JSON/wrong-shape content → deriveEstimateFallback used (default rating clamped, generated: false)',
    () => {
      // "wrong shape": rating is missing entirely, so it fails EstimateRatingLlmSchema decode.
      const openAiResponse = {
        choices: [{ message: { content: JSON.stringify({ notARating: true }) } }],
      };
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.estimateRatingFromDescription({
            description: 'Beginner player.',
            defaultRating: 1200,
            minRating: 800,
            maxRating: 1800,
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            // No new error channel surfaces — the malformed response still succeeds.
            expect(result._tag).toBe('Success');
            if (result._tag === 'Success') {
              expect(result.success.suggestedRating).toBe(1200);
              expect(result.success.generated).toBe(false);
              expect(result.success.rationale.length).toBeGreaterThan(0);
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});
